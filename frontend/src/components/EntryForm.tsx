import { IS_FRAPPE } from '../config';
import { useEffect, useMemo, useRef, useState } from 'react';
import { savePhoto } from '../data/photoStore';
import { errorMessages, RepositoryError } from '../data/repository';
import { computeActivityProgress, formatQty, roundQty } from '../domain/progress';
import { activityApplies, SUPPORTED_UNITS, UNIT_LABELS, type ActivityDef, type ElementRecord, type PhotoMeta, type ProgressEntry } from '../domain/types';
import { checkQuantity, todayISO, validateDate } from '../domain/workflow';
import { newRequestId, useApp } from '../state/AppContext';
import { PhotoPicker } from './Photos';
import { ErrorList } from './ui';

/** Edit a Draft / Returned work-done entry of one element: how far the work got, in % of the planned quantity. */
export function EntryForm({
  element,
  activities,
  entries,
  editing,
  onDone,
}: {
  element: ElementRecord;
  activities: ActivityDef[];
  entries: ProgressEntry[];
  editing?: ProgressEntry | null;
  onDone: () => void;
}) {
  const { repo, role, notify, refresh } = useApp();
  // Only activities that apply to this element type (e.g. no Concreting for a brick wall).
  const usable = activities.filter((a) => activityApplies(a, element.type));
  const firstConfigured = usable.find((a) => (element.plannedQuantities[a.code]?.quantity ?? 0) > 0) ?? usable[0];
  const [date, setDate] = useState(editing?.date ?? todayISO());
  const [activityCode, setActivityCode] = useState(editing?.activityCode ?? firstConfigured?.code ?? '');
  const [quantity, setQuantity] = useState(editing ? String(editing.quantity) : '');
  const [unit, setUnit] = useState<string>(editing?.unit ?? firstConfigured?.unit ?? '');
  const [remarks, setRemarks] = useState(editing?.remarks ?? '');
  const [photos, setPhotos] = useState<PhotoMeta[]>(editing?.photos ?? []);
  const [pending, setPending] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dupWarning, setDupWarning] = useState<string | null>(null);
  const [confirmDup, setConfirmDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const requestId = useRef(newRequestId());
  const inFlight = useRef(false);
  // Photos already written to IndexedDB during an attempt that then failed validation — reused on retry.
  const storedPhotos = useRef(new Map<File, PhotoMeta>());

  // Reset when switching element or edited entry.
  useEffect(() => {
    setDate(editing?.date ?? todayISO());
    setActivityCode(editing?.activityCode ?? firstConfigured?.code ?? '');
    setQuantity(editing ? String(editing.quantity) : '');
    setUnit(editing?.unit ?? firstConfigured?.unit ?? '');
    setRemarks(editing?.remarks ?? '');
    setPhotos(editing?.photos ?? []);
    setPending([]);
    setErrors([]);
    setDupWarning(null);
    setConfirmDup(false);
    setTouched(false);
    requestId.current = newRequestId();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element.id, editing?.id]);

  const activity = activities.find((a) => a.code === activityCode);
  const progress = useMemo(
    () => (activity ? computeActivityProgress(element, activity, entries.filter((e) => e.id !== editing?.id)) : null),
    [activity, element, entries, editing?.id],
  );
  // others = approved + awaiting work of this element and activity, not counting the entry being edited
  const others = progress ? progress.approved + progress.pendingReview : 0;
  const planned = progress?.planned ?? null;
  const [percent, setPercent] = useState('');
  const initialPct = planned && editing ? String(Math.round(((others + editing.quantity) / planned) * 100)) : '';
  useEffect(() => {
    setPercent(initialPct);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element.id, editing?.id, planned]);
  const pctNum = percent.trim() === '' ? Number.NaN : Number(percent);
  const qtyNum = planned === null ? (quantity.trim() === '' ? Number.NaN : Number(quantity)) : editing && percent === initialPct ? editing.quantity // unchanged: keep the exact quantity, not the rounded %
        : roundQty((planned * pctNum) / 100 - others);

  const liveErrors = useMemo(() => {
    if (!activity) return ['Choose an activity.'];
    return [
      ...validateDate(date),
      ...(planned !== null && !(pctNum > 0 && pctNum <= 100) ? ['Work done must be between 1 and 100 %.'] : []),
      ...(planned !== null && pctNum > 0 && !(qtyNum > 0) ? [`${Math.round((others / planned) * 100)}% is already approved or awaiting approval — enter more than that.`] : []),
      ...(planned === null && quantity.trim() === '' ? ['Enter the completed quantity.'] : []),
      ...((planned === null ? quantity.trim() === '' : !(qtyNum > 0))
        ? []
        : checkQuantity({ element, activity, quantity: qtyNum, unit, entries, excludeEntryId: editing?.id, mode: 'claim' })),
      ...(remarks.length > 500 ? ['Remarks must be 500 characters or fewer.'] : []),
    ];
  }, [activity, date, quantity, qtyNum, pctNum, planned, others, unit, element, entries, editing?.id, remarks]);

  async function save(submit: boolean) {
    setTouched(true);
    if (inFlight.current) return; // synchronous double-click guard; the repository is also idempotent per request id
    if (liveErrors.length) {
      setErrors(liveErrors);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setErrors([]);
    try {
      // Store new photos first; if that fails nothing is saved and nothing claims success.
      const stored: PhotoMeta[] = [];
      for (const f of pending) {
        const meta = storedPhotos.current.get(f) ?? (await savePhoto(f));
        storedPhotos.current.set(f, meta);
        stored.push(meta);
      }
      const entry = await repo.saveProgressEntry(
        {
          id: editing?.id,
          clientRequestId: requestId.current,
          projectId: element.projectId,
          elementId: element.id,
          activityCode,
          date,
          quantity: qtyNum,
          unit,
          remarks,
          photos: [...photos, ...stored],
          submit,
          confirmDuplicate: confirmDup,
        },
        role,
      );
      const photoNote = stored.length ? ` ${stored.length} photo(s) ${IS_FRAPPE ? 'uploaded' : 'stored in this browser'}.` : '';
      notify(`${entry.id} ${submit ? 'submitted for PMC review' : 'saved as draft'} — ${element.code} ${entry.activityName} ${formatQty(entry.quantity, UNIT_LABELS[entry.unit])}.${photoNote}`);
      requestId.current = newRequestId();
      setPending([]);
      setDupWarning(null);
      setConfirmDup(false);
      if (!editing) {
        setQuantity('');
        setRemarks('');
        setPhotos([]);
        setTouched(false);
      }
      await refresh();
      onDone();
    } catch (e) {
      if (e instanceof RepositoryError && e.code === 'possible-duplicate') {
        setDupWarning(e.message);
      } else {
        setErrors(errorMessages(e));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="entry-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      noValidate
    >
      <div className="form-grid">
        <label>
          Date
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label>
          Element
          <input value={`${element.code} (${element.id})`} readOnly />
        </label>
        <label>
          Activity
          <select
            value={activityCode}
            onChange={(e) => {
              setActivityCode(e.target.value);
              const a = activities.find((x) => x.code === e.target.value);
              if (a) setUnit(a.unit);
            }}
            disabled={!!editing}
          >
            {usable.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name} ({UNIT_LABELS[a.unit]})
                {(element.plannedQuantities[a.code]?.quantity ?? 0) > 0 ? '' : ' — not configured'}
              </option>
            ))}
          </select>
        </label>
        {planned !== null ? (
          <label>
            Work done (% of planned)
            <input type="number" inputMode="numeric" min="1" max="100" step="1" value={percent} onChange={(e) => setPercent(e.target.value)} />
            {qtyNum > 0 && <small className="muted">records {formatQty(qtyNum, UNIT_LABELS[unit as keyof typeof UNIT_LABELS] ?? unit)}</small>}
          </label>
        ) : (
        <div className="qty-unit">
          <label>
            Completed quantity
            <input
              type="number"
              inputMode="decimal"
              step="0.001"
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0.000"
              aria-invalid={touched && liveErrors.some((m) => /quantity|exceeds|negative/i.test(m))}
            />
          </label>
          <label>
            Unit
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {SUPPORTED_UNITS.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </label>
        </div>
        )}
      </div>

      {progress && (
        <div className="avail">
          {progress.planned === null ? (
            <span className="warn-text">Planned {activity?.name.toLowerCase()} quantity is not configured for {element.code}.</span>
          ) : (
            <>
              Planned <b>{formatQty(progress.planned, UNIT_LABELS[progress.unit])}</b> · Approved <b>{formatQty(progress.approved)}</b>
              {progress.pendingReview > 0 && (
                <>
                  {' '}
                  · Awaiting review <b>{formatQty(progress.pendingReview)}</b>
                </>
              )}{' '}
              · Available{' '}
              <b>{formatQty(Math.max(progress.planned - progress.approved - progress.pendingReview, 0), UNIT_LABELS[progress.unit])}</b>
            </>
          )}
        </div>
      )}

      <label>
        Remarks
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={500} placeholder="Gang, location, observations…" />
      </label>

      <PhotoPicker
        pending={pending}
        onChange={setPending}
        existing={photos}
        onRemoveExisting={(id) => setPhotos((p) => p.filter((x) => x.id !== id))}
        disabled={busy}
      />

      {touched && <ErrorList errors={errors.length ? errors : liveErrors} />}
      {dupWarning && (
        <div className="alert alert-warn" role="alert">
          <strong>Possible duplicate.</strong> {dupWarning}
          <label className="check">
            <input type="checkbox" checked={confirmDup} onChange={(e) => setConfirmDup(e.target.checked)} /> This is separate work, save it anyway
          </label>
        </div>
      )}

      <div className="form-actions">
        {editing && (
          <button type="button" className="btn" onClick={onDone} disabled={busy}>
            Cancel edit
          </button>
        )}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Saving…' : 'Save draft'}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save(true)}>
          {busy ? 'Saving…' : 'Save & submit'}
        </button>
      </div>
    </form>
  );
}

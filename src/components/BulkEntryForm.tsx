import { useEffect, useMemo, useRef, useState } from 'react';
import { savePhoto } from '../data/photoStore';
import { errorMessages, RepositoryError } from '../data/repository';
import { equalSplit, QTY_DECIMALS, sumQty, validateAllocation, type QuantityMode } from '../domain/allocation';
import { computeActivityProgress, formatQty, roundQty } from '../domain/progress';
import { activityApplies, SUPPORTED_UNITS, UNIT_LABELS, type ActivityDef, type ElementRecord, type PhotoMeta, type ProgressEntry } from '../domain/types';
import { checkQuantity, todayISO, validateDate } from '../domain/workflow';
import { newRequestId, useApp } from '../state/AppContext';
import { PhotoPicker } from './Photos';
import { ErrorList } from './ui';

/**
 * One activity entry for several selected elements. The user must explicitly choose whether
 * the quantity is a TOTAL across the selection (then allocated) or PER ELEMENT.
 */
export function BulkEntryForm({
  elements,
  activities: allActivities,
  entries,
  onDone,
}: {
  elements: ElementRecord[];
  activities: ActivityDef[];
  entries: ProgressEntry[];
  onDone: () => void;
}) {
  const { repo, role, notify, refresh } = useApp();
  // Only activities that apply to every selected element (a wall and a column share none).
  const activities = useMemo(
    () => allActivities.filter((a) => elements.every((el) => activityApplies(a, el.type))),
    [allActivities, elements],
  );
  const [date, setDate] = useState(todayISO());
  const [activityCode, setActivityCode] = useState(activities[0]?.code ?? '');
  const [unit, setUnit] = useState<string>(activities[0]?.unit ?? '');
  const [mode, setMode] = useState<QuantityMode | null>(null);
  const [value, setValue] = useState('');
  const [method, setMethod] = useState<'manual' | 'equal' | null>(null);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [dupWarning, setDupWarning] = useState<string | null>(null);
  const [confirmDup, setConfirmDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(newRequestId());
  const inFlight = useRef(false);
  const storedPhotos = useRef(new Map<File, PhotoMeta>());

  const ids = elements.map((e) => e.id).join(',');
  useEffect(() => {
    // Selection changed: allocation rows no longer match.
    setAlloc({});
    setMethod((m) => (m === 'equal' ? null : m));
    setErrors([]);
    setDupWarning(null);
    requestId.current = newRequestId();
  }, [ids]);

  // Selection changed so the chosen activity no longer applies: fall back to the first shared one.
  useEffect(() => {
    if (activities.length && !activities.some((a) => a.code === activityCode)) {
      setActivityCode(activities[0].code);
      setUnit(activities[0].unit);
    }
  }, [activities, activityCode]);

  const activity = activities.find((a) => a.code === activityCode);
  const valueNum = value.trim() === '' ? Number.NaN : Number(value);

  const rows = useMemo(
    () =>
      elements.map((el) => {
        const p = activity ? computeActivityProgress(el, activity, entries) : null;
        const available = p && p.planned !== null ? roundQty(Math.max(p.planned - p.approved - p.pendingReview, 0)) : null;
        return { el, p, available };
      }),
    [elements, activity, entries],
  );

  const quantities: Record<string, number> = useMemo(() => {
    if (mode === 'per-element') return Object.fromEntries(elements.map((e) => [e.id, valueNum]));
    if (mode === 'total' && method) {
      return Object.fromEntries(elements.map((e) => [e.id, alloc[e.id] === undefined || alloc[e.id] === '' ? Number.NaN : Number(alloc[e.id])]));
    }
    return {};
  }, [mode, method, elements, valueNum, alloc]);

  const allocCheck = mode === 'total' && method ? validateAllocation(valueNum, elements.map((e) => quantities[e.id])) : null;
  const recordedTotal = mode ? sumQty(Object.values(quantities).filter(Number.isFinite)) : 0;

  const liveErrors = useMemo(() => {
    const errs: string[] = [];
    if (!activity) return ['Choose an activity.'];
    errs.push(...validateDate(date));
    if (!mode) errs.push('Choose whether the quantity is a total across the selection or a quantity per element.');
    else if (value.trim() === '' || !(valueNum > 0)) errs.push(mode === 'total' ? 'Enter the total quantity across the selection (greater than zero).' : 'Enter the quantity per element (greater than zero).');
    else if (mode === 'total' && !method) errs.push('Choose how to allocate the total: manual allocation or an equal split.');
    else if (allocCheck && !allocCheck.ok) errs.push(...allocCheck.errors);
    if (mode && valueNum > 0 && (mode === 'per-element' || (allocCheck && allocCheck.ok))) {
      for (const el of elements) {
        checkQuantity({ element: el, activity, quantity: quantities[el.id], unit, entries, mode: 'claim' }).forEach((m) =>
          errs.push(m.startsWith(el.code) ? m : `${el.code}: ${m}`),
        );
      }
    } else if (unit !== activity.unit) {
      errs.push(`Unit mismatch: ${activity.name} is measured in ${activity.unit}, not ${unit}.`);
    }
    if (remarks.length > 500) errs.push('Remarks must be 500 characters or fewer.');
    return [...new Set(errs)];
  }, [activity, date, mode, value, valueNum, method, allocCheck, elements, quantities, unit, entries, remarks]);

  function applyEqualSplit() {
    setMethod('equal');
    try {
      const parts = equalSplit(valueNum, elements.length);
      setAlloc(Object.fromEntries(elements.map((e, i) => [e.id, String(parts[i])])));
      setErrors([]);
    } catch (e) {
      setAlloc({});
      setErrors([(e as Error).message]);
      setTouched(true);
    }
  }

  async function save(submit: boolean) {
    setTouched(true);
    if (inFlight.current) return; // synchronous double-click guard (state updates are async)
    if (liveErrors.length) {
      setErrors(liveErrors);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setErrors([]);
    try {
      const stored: PhotoMeta[] = [];
      for (const f of pending) {
        const meta = storedPhotos.current.get(f) ?? (await savePhoto(f));
        storedPhotos.current.set(f, meta);
        stored.push(meta);
      }
      const created = await repo.saveBatchEntries(
        {
          clientRequestId: requestId.current,
          projectId: elements[0].projectId,
          elementIds: elements.map((e) => e.id),
          activityCode,
          date,
          unit,
          remarks,
          photos: stored,
          mode: mode!,
          value: valueNum,
          allocationMethod: mode === 'total' ? method! : undefined,
          allocations: mode === 'total' ? quantities : undefined,
          submit,
          confirmDuplicate: confirmDup,
        },
        role,
      );
      const total = sumQty(created.map((e) => e.quantity));
      notify(
        `${created.length} entries ${submit ? 'submitted for review' : 'saved as drafts'} — ${activity!.name}, ${formatQty(total, UNIT_LABELS[activity!.unit])} in total across ${created.length} elements.`,
      );
      requestId.current = newRequestId();
      setValue('');
      setAlloc({});
      setMethod(null);
      setMode(null);
      setRemarks('');
      setPending([]);
      setTouched(false);
      setDupWarning(null);
      setConfirmDup(false);
      await refresh();
      onDone();
    } catch (e) {
      if (e instanceof RepositoryError && e.code === 'possible-duplicate') setDupWarning(e.message);
      else setErrors(errorMessages(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const unitLabel = activity ? UNIT_LABELS[activity.unit] : '';

  if (!activities.length) {
    return (
      <p className="muted">
        The selected element types ({[...new Set(elements.map((e) => e.type))].join(', ')}) have no activity in common. Select elements of
        similar types (e.g. only walls, or only columns and beams) to record one entry for all of them.
      </p>
    );
  }

  return (
    <form
      className="entry-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <div className="form-grid">
        <label>
          Date
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Activity
          <select
            value={activityCode}
            onChange={(e) => {
              setActivityCode(e.target.value);
              const a = activities.find((x) => x.code === e.target.value);
              if (a) setUnit(a.unit);
              setAlloc({});
              setMethod(null);
            }}
          >
            {activities.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name} ({UNIT_LABELS[a.unit]})
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="mode-choice">
        <legend>The quantity I am entering is…</legend>
        <label className={`radio-card ${mode === 'total' ? 'on' : ''}`}>
          <input
            type="radio"
            name="qmode"
            checked={mode === 'total'}
            onChange={() => {
              setMode('total');
              setAlloc({});
              setMethod(null);
            }}
          />
          <span>
            <b>Total across the selection</b>
            <small>e.g. one pour of 2.4 m³ shared by {elements.length} elements — you allocate it.</small>
          </span>
        </label>
        <label className={`radio-card ${mode === 'per-element' ? 'on' : ''}`}>
          <input type="radio" name="qmode" checked={mode === 'per-element'} onChange={() => setMode('per-element')} />
          <span>
            <b>Quantity per element</b>
            <small>Each of the {elements.length} elements gets this same quantity.</small>
          </span>
        </label>
      </fieldset>

      {mode && (
        <div className="qty-unit">
          <label>
            {mode === 'total' ? 'Total quantity across selection' : 'Quantity per element'}
            <input
              type="number"
              step="0.001"
              min="0"
              inputMode="decimal"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (method === 'equal') {
                  setMethod(null);
                  setAlloc({});
                }
              }}
              placeholder="0.000"
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

      {mode === 'total' && (
        <div className="alloc-methods">
          <button type="button" className={`btn btn-small ${method === 'manual' ? 'btn-on' : ''}`} onClick={() => setMethod('manual')}>
            Allocate manually
          </button>
          <button type="button" className={`btn btn-small ${method === 'equal' ? 'btn-on' : ''}`} onClick={applyEqualSplit} disabled={!(valueNum > 0)}>
            Split equally
          </button>
          {!method && <span className="hint">Choose one — the total is never copied onto each element.</span>}
        </div>
      )}

      {mode && (
        <table className="table alloc-table">
          <thead>
            <tr>
              <th>Element</th>
              <th className="num">Available</th>
              <th className="num">{mode === 'total' ? 'Allocated' : 'Will record'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ el, p, available }) => (
              <tr key={el.id}>
                <td>
                  <b>{el.code}</b> <span className="muted small">{el.type}</span>
                </td>
                <td className="num">{p?.planned === null ? <span className="warn-text">Not configured</span> : formatQty(available, unitLabel)}</td>
                <td className="num">
                  {mode === 'total' ? (
                    method ? (
                      <input
                        className="alloc-input"
                        type="number"
                        step="0.001"
                        min="0"
                        value={alloc[el.id] ?? ''}
                        readOnly={method === 'equal'}
                        onChange={(e) => setAlloc((a) => ({ ...a, [el.id]: e.target.value }))}
                        aria-label={`Allocation for ${el.code}`}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )
                  ) : Number.isFinite(valueNum) ? (
                    formatQty(valueNum, unitLabel)
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>
                {mode === 'total' ? 'Allocated / entered total' : `Total recorded (${elements.length} × per-element)`}
              </td>
              <td className={`num ${allocCheck && !allocCheck.ok && method ? 'bad' : ''}`}>
                {mode === 'total'
                  ? `${formatQty(recordedTotal)} / ${Number.isFinite(valueNum) ? formatQty(valueNum) : '—'} ${unitLabel}`
                  : formatQty(Number.isFinite(valueNum) ? roundQty(valueNum * elements.length, QTY_DECIMALS) : null, unitLabel)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      <label>
        Remarks
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={500} />
      </label>
      <PhotoPicker pending={pending} onChange={setPending} disabled={busy} />

      {touched && <ErrorList errors={errors.length ? errors : liveErrors} />}
      {dupWarning && (
        <div className="alert alert-warn" role="alert">
          <strong>Possible duplicate.</strong> {dupWarning}
          <label className="check">
            <input type="checkbox" checked={confirmDup} onChange={(e) => setConfirmDup(e.target.checked)} /> This is separate work, save anyway
          </label>
        </div>
      )}

      <div className="form-actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Saving…' : `Save ${elements.length} drafts`}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save(true)}>
          {busy ? 'Saving…' : `Save & submit ${elements.length}`}
        </button>
      </div>
    </form>
  );
}

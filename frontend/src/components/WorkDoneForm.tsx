import { IS_FRAPPE } from '../config';
import { useEffect, useMemo, useRef, useState } from 'react';
import { savePhoto } from '../data/photoStore';
import { errorMessages, RepositoryError } from '../data/repository';
import { formatQty } from '../domain/progress';
import { activityApplies, UNIT_LABELS, type ActivityDef, type ElementRecord, type PhotoMeta, type ProgressEntry } from '../domain/types';
import { markedPercent, planWorkDone } from '../domain/workDone';
import { todayISO, validateDate } from '../domain/workflow';
import { newRequestId, useApp } from '../state/AppContext';
import { PhotoPicker } from './Photos';
import { ErrorList } from './ui';

const QUICK_PERCENTS = [25, 50, 75, 100];

/**
 * Work done for the ticked elements: tick the activities that are finished (or how far they got, in %)
 * and press OK — no quantities to type. Quantities come from the model's planned quantities.
 */
export function WorkDoneForm({ elements, activities: allActivities, entries }: { elements: ElementRecord[]; activities: ActivityDef[]; entries: ProgressEntry[] }) {
  const { repo, role, notify, refresh } = useApp();
  // Activities that apply to at least one ticked element.
  const activities = useMemo(() => allActivities.filter((a) => elements.some((el) => activityApplies(a, el.type))), [allActivities, elements]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [percent, setPercent] = useState('100');
  const [date, setDate] = useState(todayISO());
  const [remarks, setRemarks] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dupWarning, setDupWarning] = useState<string | null>(null);
  const [confirmDup, setConfirmDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestIds = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const storedPhotos = useRef(new Map<File, PhotoMeta>());

  const ids = elements.map((e) => e.id).join(',');
  useEffect(() => {
    // Selection changed: start the ticks again.
    setTicked(new Set());
    setErrors([]);
    setDupWarning(null);
    setConfirmDup(false);
    requestIds.current.clear();
  }, [ids]);

  const pct = percent.trim() === '' ? Number.NaN : Number(percent);
  const pctOk = Number.isFinite(pct) && pct > 0 && pct <= 100;

  const status = useMemo(
    () =>
      activities.map((a) => {
        const marks = elements.filter((el) => activityApplies(a, el.type)).map((el) => markedPercent(el, a, entries));
        const configured = marks.filter((m): m is number => m !== null);
        return { activity: a, applies: marks.length, configured: configured.length, done: configured.filter((m) => m >= 100).length };
      }),
    [activities, elements, entries],
  );

  const plans = useMemo(
    () => (pctOk ? activities.filter((a) => ticked.has(a.code)).map((a) => planWorkDone(elements, a, entries, pct)) : []),
    [activities, ticked, elements, entries, pct, pctOk],
  );

  const liveErrors = useMemo(() => {
    const errs = [...validateDate(date)];
    if (!ticked.size) errs.push('Tick at least one activity.');
    if (!pctOk) errs.push('Work done must be between 1 and 100 %.');
    else if (ticked.size && !plans.some((p) => p.recording.length)) errs.push(`Nothing new to record — the ticked work is already marked ${pct}% or more.`);
    if (remarks.length > 500) errs.push('Remarks must be 500 characters or fewer.');
    return errs;
  }, [date, ticked, pctOk, pct, plans, remarks]);

  function toggle(code: string) {
    setTicked((t) => {
      const n = new Set(t);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
    setErrors([]);
  }

  async function save(submit: boolean) {
    if (inFlight.current) return;
    if (liveErrors.length) {
      setErrors(liveErrors);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setErrors([]);
    const done: string[] = [];
    const doneCodes = new Set<string>();
    const failed: string[] = [];
    try {
      const stored: PhotoMeta[] = [];
      for (const f of pending) {
        const meta = storedPhotos.current.get(f) ?? (await savePhoto(f));
        storedPhotos.current.set(f, meta);
        stored.push(meta);
      }
      const note = remarks.trim() || `${pct}% done`;
      for (const plan of plans) {
        if (!plan.recording.length) continue;
        const code = plan.activity.code;
        if (!requestIds.current.has(code)) requestIds.current.set(code, newRequestId());
        try {
          await repo.saveBatchEntries(
            {
              clientRequestId: requestIds.current.get(code)!,
              projectId: plan.recording[0].element.projectId,
              elementIds: plan.recording.map((r) => r.element.id),
              activityCode: code,
              date,
              unit: plan.activity.unit,
              remarks: note,
              photos: stored,
              mode: 'total',
              value: plan.total,
              allocationMethod: 'manual',
              allocations: Object.fromEntries(plan.recording.map((r) => [r.element.id, r.quantity])),
              submit,
              confirmDuplicate: confirmDup,
            },
            role,
          );
          requestIds.current.delete(code);
          done.push(plan.activity.name);
          doneCodes.add(code);
        } catch (e) {
          if (e instanceof RepositoryError && e.code === 'possible-duplicate') setDupWarning(e.message);
          failed.push(`${plan.activity.name}: ${errorMessages(e).join(' ')}`);
        }
      }
    } catch (e) {
      failed.push(...errorMessages(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (done.length) {
      notify(`${done.join(', ')} marked ${pct}% done on ${elements.length} element${elements.length === 1 ? '' : 's'} — ${submit ? 'sent for PMC approval' : 'saved as draft'}.`);
      setTicked((t) => new Set([...t].filter((c) => !doneCodes.has(c))));
      if (!failed.length) {
        setRemarks('');
        setPending([]);
        setDupWarning(null);
        setConfirmDup(false);
      }
      await refresh();
    }
    if (failed.length) setErrors(failed);
  }

  if (!activities.length) return <p className="muted">No activity applies to the selected elements.</p>;

  return (
    <form
      className="entry-form work-done"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
    >
      <fieldset className="wd-acts">
        <legend>Which work is done?</legend>
        {status.map(({ activity: a, applies, configured, done }) => {
          const allDone = configured > 0 && done === configured;
          const plan = plans.find((p) => p.activity.code === a.code);
          return (
            <label key={a.code} className={`wd-act ${ticked.has(a.code) ? 'on' : ''} ${allDone ? 'done' : ''}`}>
              <input type="checkbox" checked={ticked.has(a.code)} disabled={allDone || !configured} onChange={() => toggle(a.code)} />
              <span className="wd-name">
                <b>{a.name}</b>
                <small>
                  {!configured
                    ? 'Not planned for these elements'
                    : allDone
                      ? `✓ Marked done on all ${configured}`
                      : `${done} of ${configured} marked done${applies < elements.length ? ` · applies to ${applies} of ${elements.length}` : ''}`}
                </small>
              </span>
              {plan && (
                <span className="wd-qty">
                  {plan.recording.length ? formatQty(plan.total, UNIT_LABELS[a.unit]) : <span className="muted">nothing new</span>}
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      <div className="wd-pct">
        <span>How much?</span>
        {QUICK_PERCENTS.map((p) => (
          <button key={p} type="button" className={`btn btn-small ${pct === p ? 'btn-on' : ''}`} onClick={() => setPercent(String(p))}>
            {p === 100 ? 'Done 100%' : `${p}%`}
          </button>
        ))}
        <label className="wd-pct-input">
          <input type="number" min="1" max="100" step="1" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Work done percent" />%
        </label>
      </div>

      {plans.some((p) => p.rows.some((r) => r.skip === 'already-done')) && pctOk && (
        <p className="hint">Elements already marked {pct}% or more for a ticked activity are skipped.</p>
      )}

      <details className="wd-more">
        <summary>Date, remarks, photos</summary>
        <label>
          Date
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Remarks
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={500} placeholder="Optional" />
        </label>
        <PhotoPicker pending={pending} onChange={setPending} disabled={busy} />
      </details>

      <ErrorList errors={errors} />
      {dupWarning && (
        <div className="alert alert-warn" role="alert">
          <strong>Possible duplicate.</strong> {dupWarning}
          <label className="check">
            <input type="checkbox" checked={confirmDup} onChange={(e) => setConfirmDup(e.target.checked)} /> This is separate work, save anyway
          </label>
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save(false)}>
          Save draft
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'OK — mark done'}
        </button>
      </div>
      <p className="hint">
        Goes to the PMC Reviewer for approval; the 3D colour changes once approved.{IS_FRAPPE ? '' : ' Quantities are taken from the model planning.'}
      </p>
    </form>
  );
}

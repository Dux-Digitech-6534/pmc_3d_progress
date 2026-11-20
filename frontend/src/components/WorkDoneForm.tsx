import { IS_FRAPPE } from '../config';
import { useEffect, useMemo, useRef, useState } from 'react';
import { savePhoto } from '../data/photoStore';
import { errorMessages } from '../data/repository';
import { formatQty } from '../domain/progress';
import { activityApplies, UNIT_LABELS, type ActivityDef, type ElementRecord, type PhotoMeta, type ProgressEntry } from '../domain/types';
import { missingPriorWork } from '../domain/sequence';
import { draftQty, markedPercent, planWorkDone } from '../domain/workDone';
import { todayISO, validateDate } from '../domain/workflow';
import { newRequestId, useApp } from '../state/AppContext';
import { setPlanning, usePlanning } from '../state/planning';
import { PhotoPicker } from './Photos';
import { ErrorList } from './ui';

/**
 * Work done for the ticked elements: tick the activities, then "Started" (the start date is kept) or
 * "Completed 100%" (the work goes for PMC approval) — no quantities to type; they come from the model's
 * planned quantities. Meeting 16-11: only Started and 100%, each with its date, so the days taken are known.
 */
export function WorkDoneForm({
  elements,
  activities: allActivities,
  entries,
}: {
  elements: ElementRecord[];
  activities: ActivityDef[];
  entries: ProgressEntry[];
}) {
  const { repo, role, notify, refresh } = useApp();
  // Activities that apply to at least one ticked element.
  const activities = useMemo(() => allActivities.filter((a) => elements.some((el) => activityApplies(a, el.type))), [allActivities, elements]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [kind, setKind] = useState<'started' | 'done'>('done');
  const percent = '100';
  const { data: planning } = usePlanning();
  const [date, setDate] = useState(todayISO());
  const [remarks, setRemarks] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const requestIds = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const storedPhotos = useRef(new Map<File, PhotoMeta>());

  const ids = elements.map((e) => e.id).join(',');
  useEffect(() => {
    // Selection changed: start the ticks again.
    setTicked(new Set());
    setErrors([]);
    requestIds.current.clear();
  }, [ids]);

  const pct = percent.trim() === '' ? Number.NaN : Number(percent);
  const pctOk = Number.isFinite(pct) && pct > 0 && pct <= 100;

  const status = useMemo(
    () =>
      activities.map((a) => {
        const marks = elements.filter((el) => activityApplies(a, el.type)).map((el) => markedPercent(el, a, entries));
        const configured = marks.filter((m): m is number => m !== null);
        const drafts = elements.filter((el) => draftQty(el, a, entries) > 0).length;
        const started = elements.filter((el) => planning?.starts.some((s) => s.elementId === el.id && s.activityCode === a.code)).length;
        return { activity: a, applies: marks.length, configured: configured.length, done: configured.filter((m) => m >= 100).length, drafts, started };
      }),
    [activities, elements, entries, planning],
  );

  const plans = useMemo(
    () => (pctOk ? activities.filter((a) => ticked.has(a.code)).map((a) => planWorkDone(elements, a, entries, pct)) : []),
    [activities, ticked, elements, entries, pct, pctOk],
  );

  // work normally done before the ticked work (steel before concrete …) that is not reported yet;
  // earlier work ticked in the same go counts as reported
  const [orderOk, setOrderOk] = useState(false);
  const outOfOrder = useMemo(
    () =>
      plans
        .map((p) => {
          const missing = missingPriorWork(
            p.recording.map((r) => r.element),
            p.activity,
            allActivities.filter((a) => !ticked.has(a.code)),
            entries,
          );
          return { activity: p.activity, missing };
        })
        .filter((x) => x.missing.length),
    [plans, allActivities, ticked, entries],
  );
  useEffect(() => setOrderOk(false), [ticked, ids]);

  // "Started" only for elements not started yet: a Started date already kept, or any work already
  // entered (draft, sent or approved) means the work has begun — starting it again is not allowed
  const alreadyStarted = (elementId: string, code: string) =>
    !!planning?.starts.some((s) => s.elementId === elementId && s.activityCode === code) ||
    entries.some((e) => e.elementId === elementId && e.activityCode === code && e.status !== 'Returned' && e.quantity > 0);
  const toStart = useMemo(
    () =>
      activities
        .filter((a) => ticked.has(a.code))
        .map((a) => {
          const applies = elements.filter((el) => activityApplies(a, el.type));
          const fresh = applies.filter((el) => !alreadyStarted(el.id, a.code));
          return { activity: a, fresh, skipped: applies.length - fresh.length };
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activities, ticked, elements, planning, entries],
  );

  const undoable = useMemo(
    () =>
      activities
        .filter((a) => ticked.has(a.code))
        .map((a) => ({
          activity: a,
          ids: elements
            .filter((el) => planning?.starts.some((s) => s.elementId === el.id && s.activityCode === a.code))
            .filter((el) => !entries.some((e) => e.elementId === el.id && e.activityCode === a.code && e.status !== 'Returned' && e.quantity > 0))
            .map((el) => el.id),
        }))
        .filter((x) => x.ids.length),
    [activities, ticked, elements, planning, entries],
  );

  async function undoStarted() {
    if (inFlight.current || !undoable.length) return;
    inFlight.current = true;
    setBusy(true);
    setErrors([]);
    const projectId = elements[0].projectId;
    try {
      for (const u of undoable) setPlanning(projectId, await repo.clearStarted(projectId, u.ids, u.activity.code, role));
      notify(`Start date removed: ${undoable.map((u) => `${u.activity.name} on ${u.ids.length} element${u.ids.length === 1 ? '' : 's'}`).join(', ')}.`);
    } catch (e) {
      setErrors(errorMessages(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const liveErrors = useMemo(() => {
    const errs = [...validateDate(date)];
    if (outOfOrder.length && !orderOk) errs.push('Earlier work is not reported yet — confirm it is done on site, or report it first.');
    if (!ticked.size) errs.push('Select at least one activity.');
    if (kind === 'started') {
      const out = errs.filter((e) => !e.startsWith('Earlier work'));
      if (ticked.size && !toStart.some((t) => t.fresh.length))
        out.push('Already started — the selected work has begun on all these elements. When it is finished, choose Completed 100%.');
      return out;
    }
    if (!pctOk) errs.push('Work done must be between 1 and 100 %.');
    else if (ticked.size && !plans.some((p) => p.recording.length)) errs.push(`Nothing new to record — the selected work is already marked ${pct}% or more.`);
    if (remarks.length > 500) errs.push('Remarks must be 500 characters or fewer.');
    return errs;
  }, [date, ticked, pctOk, pct, plans, remarks, outOfOrder, orderOk, kind, toStart]);

  function toggle(code: string) {
    setTicked((t) => {
      const n = new Set(t);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
    setErrors([]);
  }

  async function saveStarted() {
    if (inFlight.current) return;
    if (liveErrors.length) {
      setErrors(liveErrors);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setErrors([]);
    const projectId = elements[0].projectId;
    const done: string[] = [];
    const failed: string[] = [];
    let count = 0;
    try {
      for (const { activity: a, fresh } of toStart) {
        if (!fresh.length) continue;
        try {
          setPlanning(projectId, await repo.markStarted(projectId, fresh.map((el) => el.id), a.code, date, role));
          done.push(a.name);
          count = Math.max(count, fresh.length);
        } catch (e) {
          failed.push(`${a.name}: ${errorMessages(e).join(' ')}`);
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (done.length) {
      notify(`${done.join(', ')} marked started on ${new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} for ${count} element${count === 1 ? '' : 's'}.`);
      setTicked(new Set());
    }
    if (failed.length) setErrors(failed);
  }

  async function save(submit: boolean) {
    if (inFlight.current) return;
    if (kind === 'started') return saveStarted();
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
              // the % only adds the work not yet recorded, so the same quantity on the same day is real work
              confirmDuplicate: true,
            },
            role,
          );
          requestIds.current.delete(code);
          done.push(plan.activity.name);
          doneCodes.add(code);
        } catch (e) {
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
      notify(
        `${done.join(', ')} marked ${pct}% done on ${elements.length} element${elements.length === 1 ? '' : 's'} — ${submit ? 'sent for PMC approval' : 'saved as draft'}.`,
      );
      setTicked((t) => new Set([...t].filter((c) => !doneCodes.has(c))));
      if (!failed.length) {
        setRemarks('');
        setPending([]);
      }
      await refresh();
    }
    if (failed.length) setErrors(failed);
  }

  if (!activities.length) return <p className="muted">No activity applies to the selected elements.</p>;
  const allMarked = status.every((s) => !s.configured || s.done === s.configured);

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
        {status.map(({ activity: a, applies, configured, done, drafts, started }) => {
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
                  {drafts > 0 && <span className="wd-draft"> · {drafts} in draft, not sent</span>}
                  {started > 0 && !allDone && <span className="wd-started"> · {started} started</span>}
                </small>
              </span>
              {plan && kind === 'done' && (
                <span className="wd-qty">
                  {plan.recording.length ? formatQty(plan.total, UNIT_LABELS[a.unit]) : <span className="muted">nothing new</span>}
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      {allMarked ? (
        <p className="hint">All work of the selected elements is marked done.</p>
      ) : !ticked.size ? (
        <p className="hint">Select the work that is done to enter it.</p>
      ) : (
        <>
          <div className="wd-kind" role="group" aria-label="What happened">
            <button type="button" className={`wd-kind-btn ${kind === 'started' ? 'on' : ''}`} onClick={() => setKind('started')}>
              <b>Started</b>
              <small>Work began — keeps the start date</small>
            </button>
            <button type="button" className={`wd-kind-btn ${kind === 'done' ? 'on' : ''}`} onClick={() => setKind('done')}>
              <b>Completed 100%</b>
              <small>Work finished — goes for PMC approval</small>
            </button>
          </div>
          <label className="wd-date">
            {kind === 'started' ? 'Start date' : 'Complete date'}
            <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </label>

          {plans.some((p) => p.rows.some((r) => r.skip === 'already-done')) && pctOk && (
            <p className="hint">Elements already marked {pct}% or more for a selected activity are skipped.</p>
          )}

          {kind === 'done' && outOfOrder.length > 0 && (
            <div className="alert alert-warn small wd-order">
              {outOfOrder.map(({ activity, missing }) => {
                const before = [...new Set(missing.flatMap((m) => m.activities.map((a) => a.name)))];
                const codes = missing.map((m) => m.element.code);
                return (
                  <p key={activity.code}>
                    <b>{activity.name}</b> normally comes after <b>{before.join(' and ')}</b>, which is not reported yet on {codes.slice(0, 8).join(', ')}
                    {codes.length > 8 ? ` +${codes.length - 8} more` : ''}.
                  </p>
                );
              })}
              <label className="check">
                <input type="checkbox" checked={orderOk} onChange={(e) => setOrderOk(e.target.checked)} /> Yes, the earlier work is done on site — continue
              </label>
            </div>
          )}

          {kind === 'done' && (
          <details className="wd-more">
            <summary>Remarks, photos</summary>
            <label>
              Remarks
              <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={500} placeholder="Optional" />
            </label>
            <PhotoPicker pending={pending} onChange={setPending} disabled={busy} />
          </details>
          )}

          <ErrorList errors={errors} />

          {kind === 'started' ? (
            <>
              {toStart.some((t) => t.skipped) && toStart.some((t) => t.fresh.length) && (
                <p className="hint">
                  Already started, skipped: {toStart.filter((t) => t.skipped).map((t) => `${t.activity.name} on ${t.skipped} element${t.skipped === 1 ? '' : 's'}`).join(', ')}.
                </p>
              )}
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? 'Saving…' : 'OK — mark started'}
                </button>
              </div>
              <p className="hint">Only the start date is kept (no quantity, no approval). When the work is finished, choose Completed 100%.</p>
              {undoable.length > 0 && (
                <p className="hint">
                  Marked Started by mistake?{' '}
                  <button type="button" className="link" disabled={busy} onClick={() => void undoStarted()}>
                    Remove the start date ({undoable.map((u) => `${u.activity.name}: ${u.ids.length}`).join(', ')})
                  </button>
                </p>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
        </>
      )}
    </form>
  );
}

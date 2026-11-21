import { useMemo, useState } from 'react';
import { EmptyState, ErrorList, PageHeader, Spinner } from '../components/ui';
import { errorMessages } from '../data/repository';
import { countResults, isCompleted, isSubmitted, NO_WORK_CODE, planEnd, planVsActual, PLAN_RESULT_LABELS, type PlanRow } from '../domain/planning';
import { ELEMENT_TYPE_LABELS } from '../domain/reports';
import { inWorkOrder } from '../domain/sequence';
import { computeActivityProgress, QTY_EPSILON } from '../domain/progress';
import { activityApplies, type ElementType } from '../domain/types';
import { todayISO } from '../domain/workflow';
import { TYPE_COLORS } from '../lib/colors';
import { useApp } from '../state/AppContext';
import { setPlanning, usePlanning } from '../state/planning';

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDay = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
/** "20 Nov" or "20 – 25 Nov". */
const rangeText = (from: string, to: string) => (to && to !== from ? `${fmtDay(from)} – ${fmtDay(to)}` : fmtDay(from));
const REASONS = ['Rain', 'Material not available', 'Labour not available', 'Machine / shuttering not ready'];

/**
 * Planning for the site engineer, kept simple (meeting 16-11):
 *   1. From – To dates, 2. tap the elements, 3. tap the work, 4. Add to plan.
 * New jobs are saved as Draft (dates can be changed, jobs removed), then Submitted (final). Below: Draft /
 * Submitted / Completed. Work reported in Work Done fills in the real start and finish by itself;
 * a job that did not happen gets "No work" with a reason (one tap for the usual reasons).
 */
export function Planning() {
  const { data, repo, role, notify, go } = useApp();
  const { data: planning, error } = usePlanning();
  const today = todayISO();
  const tomorrow = addDays(today, 1);
  // the site engineer plans (meeting 16-11); the PMC Reviewer and the Owner see the plan
  const canPlan = role === 'site-engineer';

  const [pFrom, setPFrom] = useState(tomorrow);
  const [pTo, setPTo] = useState(tomorrow);
  const [type, setType] = useState<ElementType | ''>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [works, setWorks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  // Draft = still being made (change / remove / submit); Submitted = final, not finished yet; Completed = finished
  const [view, setView] = useState<'draft' | 'submitted' | 'completed'>('draft');
  const [noWorkFor, setNoWorkFor] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [editDates, setEditDates] = useState<{ key: string; from: string; to: string } | null>(null);
  // reason of a planned "No work" (e.g. "Slab not now — waiting for columns")
  const [noWorkWhy, setNoWorkWhy] = useState('');

  const elements = useMemo(() => data?.elements ?? [], [data]);
  const activities = useMemo(() => inWorkOrder(data?.model?.document?.activities ?? []), [data]);
  const types = useMemo(() => (Object.keys(ELEMENT_TYPE_LABELS) as ElementType[]).filter((t) => elements.some((e) => e.type === t)), [elements]);
  const curType = type && types.includes(type) ? type : (types[0] ?? '');
  const typeEls = elements.filter((e) => e.type === curType);
  const typeActs = activities.filter((a) => curType && activityApplies(a, curType));

  // the plan below shows only the elements chosen above: the ticked ones, else every element of the type
  const focus = useMemo(() => new Set(picked.size ? [...picked] : typeEls.map((e) => e.id)), [picked, typeEls]);
  const all = useMemo(
    () => (planning && data ? planVsActual(planning, data.entries, elements, activities, today).filter((r) => focus.has(r.plan.elementId)) : []),
    [planning, data, elements, activities, today, focus],
  );
  const drafts = all.filter((r) => !isSubmitted(r.plan));
  const submitted = all.filter((r) => isSubmitted(r.plan) && !isCompleted(r));
  const completed = all.filter((r) => isSubmitted(r.plan) && isCompleted(r));
  const shown = view === 'draft' ? drafts : view === 'submitted' ? submitted : completed;
  // grouped by their dates (same From – To together); completed: latest first
  const groups = useMemo(() => {
    const m = new Map<string, PlanRow[]>();
    const sorted = [...shown].sort((a, b) => (view === 'completed' ? b.plan.date.localeCompare(a.plan.date) : a.plan.date.localeCompare(b.plan.date)));
    for (const r of sorted) {
      const k = `${r.plan.date}|${planEnd(r.plan)}`;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()];
  }, [shown, view]);
  const missedAll = submitted.filter((r) => r.result === 'missed').length;

  if (!data) return <Spinner />;
  if (!data.model)
    return (
      <div className="page">
        <PageHeader title="Planning" />
        <EmptyState title="No 3D model yet" action={<button className="btn btn-primary" onClick={() => go('models')}>Upload 3D + BOQ</button>}>
          Planning needs the project's 3D model.
        </EmptyState>
      </div>
    );

  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };
  const allPicked = typeEls.length > 0 && typeEls.every((e) => picked.has(e.id));
  const jobs = picked.size * works.size;
  const datesBad = !pFrom || !pTo || pTo < pFrom;

  // work already finished (approved or sent for approval, 100 %) is not planned again
  const finished = (elementId: string, code: string) => {
    const el = elements.find((e) => e.id === elementId);
    const a = activities.find((x) => x.code === code);
    if (!el || !a) return false;
    const p = computeActivityProgress(el, a, data!.entries);
    return p.planned !== null && p.approved + p.pendingReview + QTY_EPSILON >= p.planned;
  };

  async function add() {
    setErrors([]);
    setBusy(true);
    let added = 0;
    const skipped: string[] = [];
    try {
      for (const code of [...works]) {
        const ids = code === NO_WORK_CODE ? [...picked] : [...picked].filter((id) => !finished(id, code));
        for (const id of picked) if (!ids.includes(id)) skipped.push(`${elements.find((e) => e.id === id)?.code} ${activities.find((a) => a.code === code)?.name}`);
        if (!ids.length) continue;
        const out = await repo.addPlans(
          data!.project.id,
          { date: pFrom, to: pTo, activityCode: code, elementIds: ids, note: code === NO_WORK_CODE ? noWorkWhy.trim() : undefined },
          role,
        );
        setPlanning(data!.project.id, out);
        added += out.added;
      }
      if (skipped.length)
        setErrors([`Already done, not planned again: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ` +${skipped.length - 8} more` : ''}.`]);
      if (added) notify(`${added} job${added === 1 ? '' : 's'} saved as draft for ${rangeText(pFrom, pTo)} — check them and press Submit plan.`);
      else if (!skipped.length) notify(`Nothing new — these jobs are already planned for ${rangeText(pFrom, pTo)}.`);
      setWorks(new Set());
      setNoWorkWhy('');
      setView('draft');
    } catch (e) {
      setErrors(errorMessages(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<Parameters<typeof setPlanning>[1]>, done: string) {
    setErrors([]);
    try {
      setPlanning(data!.project.id, await fn());
      notify(done);
      return true;
    } catch (e) {
      setErrors(errorMessages(e));
      return false;
    }
  }
  const pid = data.project.id;
  const noWork = (id: string, reason: string) =>
    run(() => repo.setNoWork(pid, [id], reason, role), reason ? `Marked No work — ${reason}.` : 'No work removed.').then((ok) => {
      if (ok) {
        setNoWorkFor(null);
        setOther('');
      }
    });
  const remove = (ids: string[]) => run(() => repo.deletePlans(pid, ids, role), ids.length === 1 ? 'Removed from the draft.' : `${ids.length} jobs removed from the draft.`);
  const submit = (ids: string[]) =>
    run(() => repo.submitPlans(pid, ids, role), `${ids.length} job${ids.length === 1 ? '' : 's'} submitted — the plan is final now.`).then((ok) => ok && setView('submitted'));
  const saveDates = (ids: string[], from: string, to: string) =>
    run(() => repo.changePlanDates(pid, ids, from, to, role), `Dates changed to ${rangeText(from, to)}.`).then((ok) => ok && setEditDates(null));

  return (
    <div className="page">
      <PageHeader title="Planning" subtitle="Make the plan, save it as draft, change it if needed, then Submit. Work entered in Work Done is compared with the submitted plan." />
      {error && <div className="alert alert-warn">Could not read the planning: {error}</div>}
      {missedAll > 0 && (
        <div className="alert alert-warn">
          <b>{missedAll} planned job{missedAll === 1 ? '' : 's'} not reported.</b> Enter the work in Work Done, or press <b>No work</b> and give the reason.{' '}
          <button className="link" onClick={() => setView('submitted')}>
            Show them
          </button>
        </div>
      )}
      <ErrorList errors={errors} />

      <section className="dash-card plan-new">
        <h2 className="plan-h">{canPlan ? 'Plan new work' : 'Show the plan of'}</h2>
        {!canPlan && <p className="muted small">Only the Site Engineer makes the plan. Choose the elements to see their plan below.</p>}

        {canPlan && (
          <div className="plan-step">
            <span className="plan-num">1</span>
            <div>
              <div className="plan-step-title">When? (from – to)</div>
              <div className="plan-seg plan-dates">
                <label>
                  From
                  <input
                    type="date"
                    value={pFrom}
                    min={today}
                    onChange={(ev) => {
                      const v = ev.target.value;
                      if (!v) return;
                      setPFrom(v);
                      if (pTo < v) setPTo(v);
                    }}
                  />
                </label>
                <label>
                  To
                  <input type="date" value={pTo} min={pFrom || today} onChange={(ev) => ev.target.value && setPTo(ev.target.value)} />
                </label>
                {!datesBad && <span className="muted small">{rangeText(pFrom, pTo)}</span>}
              </div>
            </div>
          </div>
        )}

          <div className="plan-step">
            {canPlan && <span className="plan-num">2</span>}
            <div className="plan-grow">
              <div className="plan-step-title">Which elements?</div>
              <div className="plan-seg plan-types">
                {types.map((t) => (
                  <button
                    key={t}
                    className={curType === t ? 'on' : ''}
                    onClick={() => {
                      setType(t);
                      setPicked(new Set());
                      setWorks(new Set());
                    }}
                  >
                    <span className="swatch" style={{ background: TYPE_COLORS[t] }} />
                    {ELEMENT_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
              <div className="plan-tags">
                <button className="plan-tag plan-tag-all" onClick={() => setPicked(allPicked ? new Set() : new Set(typeEls.map((e) => e.id)))}>
                  {allPicked ? 'Unselect all' : `All ${typeEls.length}`}
                </button>
                {typeEls.map((e) => (
                  <button key={e.id} className={`plan-tag ${picked.has(e.id) ? 'on' : ''}`} onClick={() => setPicked((p) => toggle(p, e.id))} title={`${e.buildingName} – ${e.levelName}`}>
                    {e.code}
                    <small>{e.levelName}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {canPlan && (
          <>
          <div className="plan-step">
            <span className="plan-num">3</span>
            <div>
              <div className="plan-step-title">Which work?</div>
              <div className="plan-seg">
                {typeActs.map((a) => (
                  <button
                    key={a.code}
                    className={works.has(a.code) ? 'on' : ''}
                    onClick={() =>
                      setWorks((w) => {
                        const n = toggle(w, a.code);
                        n.delete(NO_WORK_CODE);
                        return n;
                      })
                    }
                  >
                    {works.has(a.code) ? '✓ ' : ''}
                    {a.name}
                  </button>
                ))}
                {/* nothing will be done on these elements in these dates */}
                <button className={`plan-nowork-btn ${works.has(NO_WORK_CODE) ? 'on' : ''}`} onClick={() => setWorks((w) => (w.has(NO_WORK_CODE) ? new Set() : new Set([NO_WORK_CODE])))}>
                  {works.has(NO_WORK_CODE) ? '✓ ' : ''}No work
                </button>
              </div>
              {works.has(NO_WORK_CODE) && (
                <div className="plan-reasons plan-nowork-why">
                  <span className="small">Why? (optional)</span>
                  {['Waiting for earlier work', 'Material not available', 'Labour not available', 'Not in this period'].map((x) => (
                    <button key={x} className={`plan-tag ${noWorkWhy === x ? 'on' : ''}`} onClick={() => setNoWorkWhy(noWorkWhy === x ? '' : x)}>
                      {x}
                    </button>
                  ))}
                  <input value={noWorkWhy} maxLength={300} onChange={(e) => setNoWorkWhy(e.target.value)} placeholder="Or type the reason" />
                </div>
              )}
            </div>
          </div>

          <div className="plan-go">
            <button className="btn btn-primary" disabled={busy || !jobs || datesBad} onClick={() => void add()}>
              {busy ? 'Adding…' : jobs ? `Add to plan — ${rangeText(pFrom, pTo)}` : 'Add to plan'}
            </button>
            <span className="muted small">
              {works.has(NO_WORK_CODE)
                ? `No work on ${picked.size} element${picked.size === 1 ? '' : 's'}`
                : `${picked.size} element${picked.size === 1 ? '' : 's'} × ${works.size} work = ${jobs} job${jobs === 1 ? '' : 's'}`}
            </span>
          </div>
          </>
          )}
      </section>

      <section className="dash-card">
        <div className="dash-card-head">
          <h2 className="plan-h">The plan</h2>
          <div className="plan-seg">
            <button className={view === 'draft' ? 'on' : ''} onClick={() => setView('draft')}>
              Draft ({drafts.length})
            </button>
            <button className={view === 'submitted' ? 'on' : ''} onClick={() => setView('submitted')}>
              Submitted ({submitted.length})
            </button>
            <button className={view === 'completed' ? 'on' : ''} onClick={() => setView('completed')}>
              Completed ({completed.length})
            </button>
          </div>
        </div>
        <p className="plan-focus">
          Showing the plan of{' '}
          <b>
            {picked.size
              ? typeEls
                  .filter((e) => picked.has(e.id))
                  .slice(0, 6)
                  .map((e) => e.code)
                  .join(', ') + (picked.size > 6 ? ` +${picked.size - 6} more` : '')
              : `all ${typeEls.length} ${ELEMENT_TYPE_LABELS[curType as ElementType]?.toLowerCase() ?? ''}s`}
          </b>{' '}
          — choose other elements above to see theirs.
        </p>
        <p className="muted small plan-help">
          {view === 'draft'
            ? 'Draft: not final yet — change the dates, remove jobs, then press Submit plan.'
            : view === 'submitted'
              ? 'Submitted: the final plan, not finished yet. Enter the work in Work Done; if a job did not happen press No work.'
              : 'Completed: planned jobs that are finished — planned dates against the real start and finish.'}
        </p>
        {view === 'draft' && canPlan && drafts.length > 1 && (
          <div className="plan-submit-all">
            <button className="btn btn-primary" onClick={() => void submit(drafts.map((r) => r.plan.id))}>
              Submit all drafts ({drafts.length})
            </button>
          </div>
        )}
        {!planning ? (
          <Spinner />
        ) : groups.length === 0 ? (
          <p className="rep-empty">{view === 'draft' ? (canPlan ? 'No draft plan. Plan new work above.' : 'No draft plan.') : view === 'submitted' ? 'Nothing submitted and open.' : 'No planned job is finished yet.'}</p>
        ) : (
          groups.map(([k, list]) => {
            const c = countResults(list);
            const [d, end] = k.split('|');
            const ids = list.map((r) => r.plan.id);
            const editing = editDates?.key === k;
            return (
              <div key={k} className="plan-day">
                <div className="plan-day-head">
                  <b>{rangeText(d, end)}</b>
                  <span className="muted small">
                    {list.length} job{list.length === 1 ? '' : 's'}
                    {view === 'completed' ? ` · ${c.done} on time${c.late ? ` · ${c.late} late` : ''}` : ''}
                    {view === 'submitted' && c.missed ? ` · ${c.missed} not reported` : ''}
                  </span>
                  {view === 'draft' && canPlan && (
                    <span className="plan-day-act">
                      {editing ? (
                        <>
                          <input type="date" value={editDates.from} min={today} onChange={(e) => setEditDates({ ...editDates, from: e.target.value, to: editDates.to < e.target.value ? e.target.value : editDates.to })} />
                          <input type="date" value={editDates.to} min={editDates.from} onChange={(e) => setEditDates({ ...editDates, to: e.target.value })} />
                          <button className="btn btn-small btn-primary" disabled={!editDates.from || !editDates.to || editDates.to < editDates.from} onClick={() => void saveDates(ids, editDates.from, editDates.to)}>
                            Save dates
                          </button>
                          <button className="link" onClick={() => setEditDates(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-small" onClick={() => setEditDates({ key: k, from: d, to: end })}>
                            Change dates
                          </button>
                          <button className="btn btn-small btn-primary" onClick={() => void submit(ids)}>
                            Submit plan ({list.length})
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </div>
                {list.map((r) => (
                  <div key={r.plan.id} className={`plan-item plan-item-${view === 'draft' ? 'draft' : r.result}`}>
                    <div className="plan-item-main">
                      <b>{r.element?.code ?? r.plan.elementId}</b> <span>{r.activity?.name ?? r.plan.activityCode}</span>
                      <div className="muted small">{r.element ? `${r.element.buildingName} – ${r.element.levelName}` : ''}</div>
                    </div>
                    {/* plan vs actual on the same line: planned dates, real start, real finish */}
                    <div className="plan-dates-row">
                      <span>
                        <small>Planned</small>
                        {rangeText(r.plan.date, planEnd(r.plan))}
                      </span>
                      <span>
                        <small>Started</small>
                        {r.actualStart ? fmtDay(r.actualStart) : '—'}
                      </span>
                      <span>
                        <small>Completed</small>
                        {r.actualDone ? fmtDay(r.actualDone) : '—'}
                      </span>
                    </div>
                    <span className="plan-result">
                      {view === 'draft' ? (
                        <span className="plan-res plan-res-draft">Draft</span>
                      ) : (
                        <>
                          <span className={`plan-res plan-res-${r.result}`}>{PLAN_RESULT_LABELS[r.result]}</span>
                          {(r.result === 'late' || r.result === 'no-work') && <small className="muted">{r.result === 'no-work' ? (r.plan.noWork?.reason ?? r.detail) : r.detail}</small>}
                        </>
                      )}
                    </span>
                    {canPlan && (
                      <div className="plan-item-act">
                        {view === 'draft' && (
                          <button className="link danger-link" onClick={() => void remove([r.plan.id])} title="Remove from the draft">
                            ✕
                          </button>
                        )}
                        {view === 'submitted' && (r.result === 'missed' || r.result === 'pending') && (
                          <button className="btn btn-small" onClick={() => setNoWorkFor(noWorkFor === r.plan.id ? null : r.plan.id)}>
                            No work
                          </button>
                        )}
                        {view === 'submitted' && r.result === 'no-work' && r.plan.activityCode !== NO_WORK_CODE && (
                          <button className="link" onClick={() => void noWork(r.plan.id, '')}>
                            Undo
                          </button>
                        )}
                      </div>
                    )}
                    {noWorkFor === r.plan.id && (
                      <div className="plan-reasons">
                        <span className="small">Why was it not done?</span>
                        {REASONS.map((x) => (
                          <button key={x} className="plan-tag" onClick={() => void noWork(r.plan.id, x)}>
                            {x}
                          </button>
                        ))}
                        <input value={other} maxLength={300} onChange={(e) => setOther(e.target.value)} placeholder="Other reason" />
                        <button className="btn btn-small btn-primary" disabled={!other.trim()} onClick={() => void noWork(r.plan.id, other)}>
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })
        )}
        <p className="rep-note">
          Started / Completed fill in by themselves from Work Done. The full plan vs actual for any dates is in{' '}
          <button className="link" onClick={() => go('reports')}>
            Reports
          </button>
          .
        </p>
      </section>
    </div>
  );
}

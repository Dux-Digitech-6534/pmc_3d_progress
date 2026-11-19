import { useMemo, useState } from 'react';
import { EmptyState, ErrorList, PageHeader, Spinner } from '../components/ui';
import { errorMessages } from '../data/repository';
import { countResults, planVsActual, PLAN_RESULT_LABELS, type PlanResult } from '../domain/planning';
import { elementLabel, ELEMENT_TYPE_LABELS } from '../domain/reports';
import { inWorkOrder } from '../domain/sequence';
import { activityApplies, type ElementType } from '../domain/types';
import { todayISO } from '../domain/workflow';
import { useApp } from '../state/AppContext';
import { setPlanning, usePlanning } from '../state/planning';

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDay = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * Planning (meeting 16-11): the site engineer plans which work will be done on a date; afterwards each
 * planned job is Done (work reported that day), Started, or "No work" with the reason. A planned job
 * left without any of these is "Not reported".
 */
export function Planning() {
  const { data, repo, role, notify, go } = useApp();
  const { data: planning, error, reload } = usePlanning();
  const today = todayISO();
  const canPlan = role === 'site-engineer' || role === 'pmc-reviewer';

  // ---- add to plan ----
  const [date, setDate] = useState(today);
  const [type, setType] = useState<ElementType | ''>('');
  const [code, setCode] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // ---- list ----
  const [from, setFrom] = useState(addDays(today, -7));
  const [to, setTo] = useState(addDays(today, 7));
  const [show, setShow] = useState<'all' | PlanResult>('all');
  const [noWorkFor, setNoWorkFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const elements = useMemo(() => data?.elements ?? [], [data]);
  const activities = useMemo(() => inWorkOrder(data?.model?.document?.activities ?? []), [data]);
  const types = useMemo(() => (Object.keys(ELEMENT_TYPE_LABELS) as ElementType[]).filter((t) => elements.some((e) => e.type === t)), [elements]);
  const curType = type || types[0] || '';
  const typeActs = activities.filter((a) => curType && activityApplies(a, curType));
  const curCode = typeActs.some((a) => a.code === code) ? code : (typeActs[0]?.code ?? '');
  const listEls = elements.filter((e) => e.type === curType);

  const rows = useMemo(
    () => (planning && data ? planVsActual(planning, data.entries, elements, activities, today, from, to) : []),
    [planning, data, elements, activities, today, from, to],
  );
  const counts = countResults(rows);
  const shown = rows.filter((r) => show === 'all' || r.result === show);

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

  async function add() {
    setErrors([]);
    if (!picked.size) return setErrors(['Select at least one element.']);
    setBusy(true);
    try {
      const out = await repo.addPlans(data!.project.id, { date, activityCode: curCode, elementIds: [...picked], note }, role);
      setPlanning(data!.project.id, out);
      notify(`${out.added} job${out.added === 1 ? '' : 's'} added to the plan for ${fmtDay(date)}${out.skipped ? ` (${out.skipped} already planned)` : ''}.`);
      setPicked(new Set());
      setNote('');
    } catch (e) {
      setErrors(errorMessages(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<{ plans: unknown[] }>, done: string) {
    setErrors([]);
    try {
      const out = (await fn()) as Parameters<typeof setPlanning>[1];
      setPlanning(data!.project.id, out);
      notify(done);
    } catch (e) {
      setErrors(errorMessages(e));
    }
  }

  const allPicked = listEls.length > 0 && listEls.every((e) => picked.has(e.id));

  return (
    <div className="page">
      <PageHeader
        title="Planning"
        subtitle="Plan the work for a date. Afterwards report it in Work Done (Started / Completed), or mark No work with the reason."
      />
      {error && <div className="alert alert-warn">Could not read the planning: {error}</div>}
      <ErrorList errors={errors} />

      {canPlan && (
        <section className="dash-card">
          <div className="dash-card-head">
            <div>
              <h2>Add to plan</h2>
              <p>Pick the date, the work and the elements.</p>
            </div>
          </div>
          <div className="filters plan-form">
            <label>
              Date
              <input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              Element type
              <select value={curType} onChange={(e) => (setType(e.target.value as ElementType), setPicked(new Set()))}>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {ELEMENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Work
              <select value={curCode} onChange={(e) => setCode(e.target.value)}>
                {typeActs.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grow">
              Note (optional)
              <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. labour gang 2" />
            </label>
          </div>
          <div className="plan-pick">
            <div className="plan-pick-head">
              <b>
                {picked.size} of {listEls.length} {ELEMENT_TYPE_LABELS[curType as ElementType]?.toLowerCase()}s selected
              </b>
              <button className="link" onClick={() => setPicked(allPicked ? new Set() : new Set(listEls.map((e) => e.id)))}>
                {allPicked ? 'Unselect all' : 'Select all'}
              </button>
            </div>
            <div className="plan-pick-list">
              {listEls.map((e) => (
                <label key={e.id} className={picked.has(e.id) ? 'on' : ''}>
                  <input
                    type="checkbox"
                    checked={picked.has(e.id)}
                    onChange={() => {
                      const n = new Set(picked);
                      if (n.has(e.id)) n.delete(e.id);
                      else n.add(e.id);
                      setPicked(n);
                    }}
                  />
                  {elementLabel(e)}
                </label>
              ))}
            </div>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" disabled={busy || !picked.size || !curCode} onClick={() => void add()}>
              {busy ? 'Adding…' : `Add to plan (${picked.size})`}
            </button>
          </div>
        </section>
      )}

      <section className="dash-card">
        <div className="dash-card-head">
          <div>
            <h2>Plan vs actual</h2>
            <p>Done = work reported that day · Started = marked started that day · Not reported = date over, nothing entered.</p>
          </div>
          <button className="link" onClick={() => void reload()}>
            Refresh
          </button>
        </div>
        <div className="filters plan-filters">
          <label>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            Show
            <select value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
              <option value="all">All ({rows.length})</option>
              {(Object.keys(PLAN_RESULT_LABELS) as PlanResult[]).map((r) => (
                <option key={r} value={r}>
                  {PLAN_RESULT_LABELS[r]} ({counts[r]})
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="plan-counts">
          <span className="plan-res plan-res-done">{counts.done} done</span>
          <span className="plan-res plan-res-started">{counts.started} started</span>
          <span className="plan-res plan-res-no-work">{counts['no-work']} no work</span>
          <span className="plan-res plan-res-missed">{counts.missed} not reported</span>
          <span className="plan-res plan-res-pending">{counts.pending} planned</span>
        </p>
        {!planning ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <p className="rep-empty">Nothing planned in these dates.</p>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table rep-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Element</th>
                  <th>Work</th>
                  <th>Result</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.plan.id} className={r.result === 'missed' ? 'plan-row-missed' : ''}>
                    <td className="nowrap">{fmtDay(r.plan.date)}</td>
                    <td>
                      <b>{r.element ? elementLabel(r.element) : r.plan.elementId}</b>
                      {r.plan.note && <div className="muted small">{r.plan.note}</div>}
                    </td>
                    <td>{r.activity?.name ?? r.plan.activityCode}</td>
                    <td>
                      <span className={`plan-res plan-res-${r.result}`}>{PLAN_RESULT_LABELS[r.result]}</span>
                      <div className="muted small">{r.detail}</div>
                    </td>
                    <td className="nowrap num">
                      {canPlan && noWorkFor === r.plan.id ? (
                        <span className="plan-nowork">
                          <input autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. rain" />
                          <button
                            className="btn btn-small btn-primary"
                            disabled={!reason.trim()}
                            onClick={() =>
                              void act(() => repo.setNoWork(data.project.id, [r.plan.id], reason, role), 'Marked No work.').then(() => {
                                setNoWorkFor(null);
                                setReason('');
                              })
                            }
                          >
                            Save
                          </button>
                          <button className="link" onClick={() => setNoWorkFor(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : canPlan ? (
                        <>
                          {(r.result === 'missed' || r.result === 'pending') && (
                            <button className="link" onClick={() => (setNoWorkFor(r.plan.id), setReason(''))}>
                              No work
                            </button>
                          )}
                          {r.result === 'no-work' && (
                            <button className="link" onClick={() => void act(() => repo.setNoWork(data.project.id, [r.plan.id], '', role), 'No work removed.')}>
                              Undo No work
                            </button>
                          )}
                          {r.result === 'pending' && (
                            <button className="link danger-link" onClick={() => void act(() => repo.deletePlans(data.project.id, [r.plan.id], role), 'Removed from the plan.')}>
                              Remove
                            </button>
                          )}
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

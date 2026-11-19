import { useMemo, useState } from 'react';
import { EmptyState, ErrorList, PageHeader, Spinner } from '../components/ui';
import { errorMessages } from '../data/repository';
import { countResults, planEnd, planVsActual, PLAN_RESULT_LABELS, type PlanRow } from '../domain/planning';
import { ELEMENT_TYPE_LABELS } from '../domain/reports';
import { inWorkOrder } from '../domain/sequence';
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
 * Below: the plans (now / coming up / past). Work reported in Work Done marks a job Done / Started by itself;
 * a job that did not happen gets "No work" with a reason (one tap for the usual reasons).
 */
export function Planning() {
  const { data, repo, role, notify, go } = useApp();
  const { data: planning, error } = usePlanning();
  const today = todayISO();
  const tomorrow = addDays(today, 1);
  const canPlan = role === 'site-engineer' || role === 'pmc-reviewer';

  const [pFrom, setPFrom] = useState(tomorrow);
  const [pTo, setPTo] = useState(tomorrow);
  const [type, setType] = useState<ElementType | ''>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [works, setWorks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [view, setView] = useState<'now' | 'upcoming' | 'past'>('now');
  const [noWorkFor, setNoWorkFor] = useState<string | null>(null);
  const [other, setOther] = useState('');

  const elements = useMemo(() => data?.elements ?? [], [data]);
  const activities = useMemo(() => inWorkOrder(data?.model?.document?.activities ?? []), [data]);
  const types = useMemo(() => (Object.keys(ELEMENT_TYPE_LABELS) as ElementType[]).filter((t) => elements.some((e) => e.type === t)), [elements]);
  const curType = type && types.includes(type) ? type : (types[0] ?? '');
  const typeEls = elements.filter((e) => e.type === curType);
  const typeActs = activities.filter((a) => curType && activityApplies(a, curType));

  // now = plans running today; coming up = starting after today; past = ended before today
  const range = view === 'now' ? [today, today] : view === 'upcoming' ? [tomorrow, addDays(today, 365)] : [addDays(today, -365), addDays(today, -1)];
  const rows = useMemo(
    () => (planning && data ? planVsActual(planning, data.entries, elements, activities, today, range[0], range[1]) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planning, data, elements, activities, today, view],
  );
  // grouped by their dates (same From – To together)
  const byDay = useMemo(() => {
    const m = new Map<string, PlanRow[]>();
    const kept = rows.filter((r) => (view === 'upcoming' ? r.plan.date > today : view === 'past' ? planEnd(r.plan) < today : true));
    for (const r of [...kept].sort((a, b) => (view === 'past' ? b.plan.date.localeCompare(a.plan.date) : a.plan.date.localeCompare(b.plan.date)))) {
      const k = `${r.plan.date}|${planEnd(r.plan)}`;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()];
  }, [rows, view, today]);
  const missedAll = useMemo(
    () => (planning && data ? planVsActual(planning, data.entries, elements, activities, today).filter((r) => r.result === 'missed').length : 0),
    [planning, data, elements, activities, today],
  );

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

  async function add() {
    setErrors([]);
    setBusy(true);
    let added = 0;
    try {
      for (const code of [...works]) {
        const out = await repo.addPlans(data!.project.id, { date: pFrom, to: pTo, activityCode: code, elementIds: [...picked] }, role);
        setPlanning(data!.project.id, out);
        added += out.added;
      }
      notify(`${added} job${added === 1 ? '' : 's'} planned for ${rangeText(pFrom, pTo)}.`);
      setPicked(new Set());
      setWorks(new Set());
      setView(pFrom <= today ? 'now' : 'upcoming');
    } catch (e) {
      setErrors(errorMessages(e));
    } finally {
      setBusy(false);
    }
  }

  async function noWork(id: string, reason: string) {
    setErrors([]);
    try {
      setPlanning(data!.project.id, await repo.setNoWork(data!.project.id, [id], reason, role));
      setNoWorkFor(null);
      setOther('');
      notify(reason ? `Marked No work — ${reason}.` : 'No work removed.');
    } catch (e) {
      setErrors(errorMessages(e));
    }
  }

  async function remove(id: string) {
    try {
      setPlanning(data!.project.id, await repo.deletePlans(data!.project.id, [id], role));
      notify('Removed from the plan.');
    } catch (e) {
      setErrors(errorMessages(e));
    }
  }

  return (
    <div className="page">
      <PageHeader title="Planning" subtitle="Plan what will be done. When the work happens, enter it in Work Done as usual — the plan updates by itself." />
      {error && <div className="alert alert-warn">Could not read the planning: {error}</div>}
      {missedAll > 0 && (
        <div className="alert alert-warn">
          <b>{missedAll} planned job{missedAll === 1 ? '' : 's'} not reported.</b> Enter the work in Work Done, or press <b>No work</b> and give the reason.{' '}
          <button className="link" onClick={() => setView('past')}>
            Show them
          </button>
        </div>
      )}
      <ErrorList errors={errors} />

      {canPlan && (
        <section className="dash-card plan-new">
          <h2 className="plan-h">Plan new work</h2>

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

          <div className="plan-step">
            <span className="plan-num">2</span>
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
                  <button key={e.id} className={`plan-tag ${picked.has(e.id) ? 'on' : ''}`} onClick={() => setPicked(toggle(picked, e.id))} title={`${e.buildingName} – ${e.levelName}`}>
                    {e.code}
                    <small>{e.levelName}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="plan-step">
            <span className="plan-num">3</span>
            <div>
              <div className="plan-step-title">Which work?</div>
              <div className="plan-seg">
                {typeActs.map((a) => (
                  <button key={a.code} className={works.has(a.code) ? 'on' : ''} onClick={() => setWorks(toggle(works, a.code))}>
                    {works.has(a.code) ? '✓ ' : ''}
                    {a.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="plan-go">
            <button className="btn btn-primary" disabled={busy || !jobs || datesBad} onClick={() => void add()}>
              {busy ? 'Adding…' : jobs ? `Add to plan — ${rangeText(pFrom, pTo)}` : 'Add to plan'}
            </button>
            <span className="muted small">
              {picked.size} element{picked.size === 1 ? '' : 's'} × {works.size} work = {jobs} job{jobs === 1 ? '' : 's'}
            </span>
          </div>
        </section>
      )}

      <section className="dash-card">
        <div className="dash-card-head">
          <h2 className="plan-h">The plan</h2>
          <div className="plan-seg">
            <button className={view === 'now' ? 'on' : ''} onClick={() => setView('now')}>
              Running now
            </button>
            <button className={view === 'upcoming' ? 'on' : ''} onClick={() => setView('upcoming')}>
              Coming up
            </button>
            <button className={view === 'past' ? 'on' : ''} onClick={() => setView('past')}>
              Past
            </button>
          </div>
        </div>
        {!planning ? (
          <Spinner />
        ) : byDay.length === 0 ? (
          <p className="rep-empty">{view === 'now' ? 'No plan running today.' : view === 'upcoming' ? 'Nothing planned ahead.' : 'No past plans.'}</p>
        ) : (
          byDay.map(([k, list]) => {
            const c = countResults(list);
            const [d, end] = k.split('|');
            return (
              <div key={k} className="plan-day">
                <div className="plan-day-head">
                  <b>{rangeText(d, end)}</b>
                  <span className="muted small">
                    {list.length} planned · {c.done} done{c.started ? ` · ${c.started} started` : ''}
                    {c['no-work'] ? ` · ${c['no-work']} no work` : ''}
                    {c.missed ? ` · ${c.missed} not reported` : ''}
                  </span>
                </div>
                {list.map((r) => (
                  <div key={r.plan.id} className={`plan-item plan-item-${r.result}`}>
                    <div className="plan-item-main">
                      <b>{r.element?.code ?? r.plan.elementId}</b> <span>{r.activity?.name ?? r.plan.activityCode}</span>
                      <div className="muted small">
                        {r.element ? `${r.element.buildingName} – ${r.element.levelName}` : ''}
                        {r.result === 'no-work' ? ` · ${r.plan.noWork?.reason}` : r.result === 'done' ? ` · ${r.detail}` : ''}
                      </div>
                    </div>
                    <span className={`plan-res plan-res-${r.result}`}>{PLAN_RESULT_LABELS[r.result]}</span>
                    {canPlan && (
                      <div className="plan-item-act">
                        {(r.result === 'missed' || r.result === 'pending') && (
                          <button className="btn btn-small" onClick={() => setNoWorkFor(noWorkFor === r.plan.id ? null : r.plan.id)}>
                            No work
                          </button>
                        )}
                        {r.result === 'no-work' && (
                          <button className="link" onClick={() => void noWork(r.plan.id, '')}>
                            Undo
                          </button>
                        )}
                        {r.result === 'pending' && (
                          <button className="link danger-link" onClick={() => void remove(r.plan.id)} title="Remove from the plan">
                            ✕
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
          Done / Started fill in by themselves from Work Done. The full plan vs actual for any dates is in{' '}
          <button className="link" onClick={() => go('reports')}>
            Reports
          </button>
          .
        </p>
      </section>
    </div>
  );
}

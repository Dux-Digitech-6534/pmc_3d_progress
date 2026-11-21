import { useMemo, useState } from 'react';
import { EmptyState, PageHeader, PageLoading } from '../components/ui';
import { formatQty } from '../domain/progress';
import { categoryStatus, elementLabel, ELEMENT_TYPE_LABELS, executiveSummary, presetRange, type CountMode } from '../domain/reports';
import { inWorkOrder } from '../domain/sequence';
import { UNIT_LABELS, type ElementType } from '../domain/types';
import { todayISO } from '../domain/workflow';
import { downloadXlsx, type Cell } from '../lib/xlsxWriter';
import { useApp } from '../state/AppContext';
import { completeDateOf, countResults, daysTaken, isSubmitted, planEnd, planVsActual, PLAN_RESULT_LABELS } from '../domain/planning';
import { usePlanning } from '../state/planning';

const fmtDay = (ymd: string) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const pct = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `${p}%`);
const tone = (stage: string) => (stage === 'complete' ? 'done' : stage === 'not-started' || stage === 'no-plan' ? 'none' : 'doing');

/**
 * The executive report asked for in the boss meeting, on ONE page:
 *  1. how much work was done between two dates (m³ concrete, kg steel, m² shuttering …);
 *  2. where each type of element stands ("Footing: 10 complete · 5 steel done · 2 on shuttering · rest not started").
 * Filters: dates, building, element type, one element. Read only: it never changes any entry.
 */
export function Reports() {
  const { data, go, setSelection } = useApp();
  const [mode, setMode] = useState<CountMode>('approved');
  const [dates, setDates] = useState(() => presetRange('month'));
  const [buildingId, setBuildingId] = useState('');
  const [type, setType] = useState<ElementType | ''>('');
  const [elementId, setElementId] = useState('');
  const [showFloors, setShowFloors] = useState(false);

  const elements = useMemo(() => data?.elements ?? [], [data]);
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const activities = useMemo(() => data?.model?.document?.activities ?? [], [data]);
  const buildings = data?.model?.document?.buildings ?? [];

  // the element list follows the building and type chosen
  const inScope = useMemo(
    () => elements.filter((e) => (!buildingId || e.buildingId === buildingId) && (!type || e.type === type)),
    [elements, buildingId, type],
  );
  const types = useMemo(() => {
    const present = new Set(elements.filter((e) => !buildingId || e.buildingId === buildingId).map((e) => e.type));
    return (Object.keys(ELEMENT_TYPE_LABELS) as ElementType[]).filter((t) => present.has(t));
  }, [elements, buildingId]);
  const element = inScope.find((e) => e.id === elementId) ?? null;
  const elementIdOk = element ? element.id : '';

  const summary = useMemo(
    () => executiveSummary(elements, entries, activities, { from: dates.from, to: dates.to, buildingId, type, elementId: elementIdOk, mode }),
    [elements, entries, activities, dates.from, dates.to, buildingId, type, elementIdOk, mode],
  );
  // planning (start dates, plans) of this project
  const { data: planning } = usePlanning();
  const planningStarts = useMemo(() => planning?.starts ?? [], [planning]);
  const statuses = useMemo(
    () =>
      types
        .filter((t) => !type || t === type)
        .map((t) => ({ type: t, s: categoryStatus(elements, entries, activities, t, mode, buildingId, planningStarts) }))
        .filter((x) => x.s.rows.length),
    [types, type, elements, entries, activities, mode, buildingId, planningStarts],
  );
  // activity columns of the summary table: those planned for any type shown, in site order
  // start / complete dates of each element (Work Done "Started" and the entry that made it 100 %)
  const datesOf = (el: (typeof elements)[number], stage: string) => {
    const starts = (planning?.starts ?? []).filter((s) => s.elementId === el.id).map((s) => s.date);
    const firstEntry = entries.filter((e) => e.elementId === el.id && (e.status === 'Approved' || e.status === 'Submitted')).map((e) => e.date);
    const started = [...starts, ...firstEntry].sort()[0];
    const done =
      stage === 'complete'
        ? activities
            .filter((a) => el.plannedQuantities[a.code]?.quantity)
            .map((a) => completeDateOf(el, a.code, entries))
            .filter((d): d is string => !!d)
            .sort()
            .at(-1)
        : undefined;
    return { started, done, days: daysTaken(started, done) };
  };
  // plan vs actual for the same dates and elements
  const planRows = useMemo(() => {
    if (!planning) return [];
    const ok = new Set(elements.filter((e) => (!buildingId || e.buildingId === buildingId) && (!type || e.type === type) && (!elementIdOk || e.id === elementIdOk)).map((e) => e.id));
    return planVsActual(planning, entries, elements, activities, todayISO(), dates.from, dates.to).filter((r) => ok.has(r.plan.elementId) && isSubmitted(r.plan)); // only the submitted (final) plan is compared
  }, [planning, entries, elements, activities, dates.from, dates.to, buildingId, type, elementIdOk]);
  const planCounts = countResults(planRows);

  const statusActs = inWorkOrder(activities.filter((a) => statuses.some((x) => x.s.activityPercent[a.code] !== null && x.s.activityPercent[a.code] !== undefined)));

  if (!data) return <PageLoading />;
  if (!data.model)
    return (
      <div className="page">
        <PageHeader title="Reports" />
        <EmptyState title="No 3D model yet" action={<button className="btn btn-primary" onClick={() => go('models')}>Upload 3D + BOQ</button>}>
          Reports need the project's 3D model and BOQ.
        </EmptyState>
      </div>
    );

  const dateError = dates.from && dates.to && dates.from > dates.to ? '"From" date is after "To" date.' : null;
  const periodText =
    !dates.from && !dates.to ? 'All dates' : dates.from === dates.to ? fmtDay(dates.from) : `${fmtDay(dates.from) || 'Start'} – ${fmtDay(dates.to) || 'today'}`;
  const scopeText = element
    ? elementLabel(element)
    : [buildings.find((b) => b.id === buildingId)?.name ?? (buildings.length > 1 ? 'All buildings' : ''), type ? `${ELEMENT_TYPE_LABELS[type]}s` : 'All elements']
        .filter(Boolean)
        .join(' · ');
  const countText = mode === 'approved' ? 'approved work only' : 'approved + waiting for approval';
  const filtered = !!(buildingId || type || elementIdOk);
  const show = (id: string) => {
    setSelection(new Set([id]));
    go('workspace');
  };

  // the report as a printable Excel sheet (same three parts as the page)
  function download() {
    const acts = summary.activities;
    const unit = (a: { unit: string }) => UNIT_LABELS[a.unit as keyof typeof UNIT_LABELS] ?? a.unit;
    const ncol = Math.max(8, 5 + statusActs.length);
    const last = String.fromCharCode(64 + ncol);
    const pad = (r: (Cell | null)[]) => [...r, ...Array.from({ length: Math.max(ncol - r.length, 0) }, () => ({ v: '', s: 'plain' as const }))];
    const head = (labels: string[]) => labels.map((v) => ({ v, s: 'head' as const }));
    const rows: (Cell | null)[][] = [];
    const merges: string[] = [`A1:${last}1`];
    const add = (r: (Cell | null)[], merge?: string) => {
      rows.push(r);
      if (merge) merges.push(merge.replace(/#/g, String(rows.length)));
    };
    const section = (t: string) => add([{ v: t, s: 'label' }]);
    const note = (t: string) => add([{ v: t, s: 'note' }], `A#:${last}#`);

    add([{ v: 'PMC PROGRESS REPORT', s: 'title' }]);
    add([{ v: 'Project', s: 'label' }, { v: `${data!.project.name} (${data!.project.id})`, s: 'plain' }, null, null, null, null, { v: 'Printed', s: 'label' }, { v: fmtDay(todayISO()), s: 'plain' }], 'B#:F#');
    add([{ v: 'Dates', s: 'label' }, { v: periodText, s: 'plain' }], `B#:${last}#`);
    add([{ v: 'Showing', s: 'label' }, { v: scopeText, s: 'plain' }], `B#:${last}#`);
    add([{ v: 'Counted', s: 'label' }, { v: countText, s: 'plain' }], `B#:${last}#`);
    add([]);

    section('1. Work done');
    if (acts.length) {
      add(head(['Activity', 'Quantity', 'Unit']));
      for (const a of acts) add([{ v: a.name, s: 'cell' }, { v: summary.totals[a.code] ?? 0, s: 'num' }, { v: unit(a), s: 'cell' }]);
      if (summary.byFloor.length > 1) {
        add([]);
        add([{ v: 'Floor-wise', s: 'label' }]);
        add(head(['Building – Floor', ...acts.map((a) => `${a.name} (${unit(a)})`)]));
        for (const g of summary.byFloor) add([{ v: g.label.join(' – '), s: 'cell' }, ...acts.map((a) => ({ v: g.qty[a.code] ?? 0, s: 'num' as const }))]);
      }
    } else note('No work in these dates.');
    add([]);

    section('2. Element status (as of today)');
    add(head(['Element type', 'Total', 'Complete', 'In progress', 'Not started', ...statusActs.map((a) => `${a.name} %`)]));
    for (const { type: t, s } of statuses)
      add([
        { v: ELEMENT_TYPE_LABELS[t], s: 'cell' },
        { v: s.rows.length, s: 'int' },
        { v: s.counts.complete, s: 'int' },
        { v: s.counts.going, s: 'int' },
        { v: s.counts.notStarted, s: 'int' },
        ...statusActs.map((a) => ({ v: pct(s.activityPercent[a.code]), s: 'cell' as const })),
      ]);
    add([
      { v: 'Total', s: 'totalLabel' },
      { v: statuses.reduce((n, x) => n + x.s.rows.length, 0), s: 'total' },
      { v: statuses.reduce((n, x) => n + x.s.counts.complete, 0), s: 'total' },
      { v: statuses.reduce((n, x) => n + x.s.counts.going, 0), s: 'total' },
      { v: statuses.reduce((n, x) => n + x.s.counts.notStarted, 0), s: 'total' },
      ...statusActs.map(() => ({ v: '', s: 'totalLabel' as const })),
    ]);
    add([]);
    add([{ v: 'Element-wise', s: 'label' }]);
    add(head(['Element', 'Type', 'Stage', 'Started', 'Completed', 'Days']));
    for (const { type: t, s } of statuses)
      for (const r of s.rows.filter((x) => !elementIdOk || x.element.id === elementIdOk)) {
        const d = datesOf(r.element, r.stage);
        add([
          { v: elementLabel(r.element), s: 'cell' },
          { v: ELEMENT_TYPE_LABELS[t], s: 'cell' },
          { v: r.label, s: 'cell' },
          { v: d.started ? fmtDay(d.started) : '—', s: 'cell' },
          { v: d.done ? fmtDay(d.done) : '—', s: 'cell' },
          d.days !== undefined && d.days !== null ? { v: d.days, s: 'int' } : { v: '—', s: 'cell' },
        ]);
      }
    add([]);

    section('3. Plan vs actual');
    if (planRows.length) {
      add(head(['Element', 'Work', 'Planned', 'Started', 'Completed', 'Result', 'Detail']), `G#:${last}#`);
      for (const r of planRows)
        add(
          [
            { v: r.element ? elementLabel(r.element) : r.plan.elementId, s: 'cell' },
            { v: r.activity?.name ?? r.plan.activityCode, s: 'cell' },
            { v: r.plan.date === planEnd(r.plan) ? fmtDay(r.plan.date) : `${fmtDay(r.plan.date)} – ${fmtDay(planEnd(r.plan))}`, s: 'cell' },
            { v: r.actualStart ? fmtDay(r.actualStart) : '—', s: 'cell' },
            { v: r.actualDone ? fmtDay(r.actualDone) : '—', s: 'cell' },
            { v: PLAN_RESULT_LABELS[r.result], s: 'cell' },
            { v: r.detail, s: 'cell' },
          ],
          `G#:${last}#`,
        );
    } else note('No submitted plan in these dates.');
    add([]);
    add([]);
    add([null, { v: 'Prepared by (Site Engineer)', s: 'sign' }, null, { v: 'Checked by (PMC)', s: 'sign' }, null, null, { v: 'Approved by', s: 'sign' }]);

    downloadXlsx(`pmc-report-${data!.project.id}-${todayISO()}.xlsx`, {
      name: 'PMC Report',
      cols: [38, 16, 22, 15, 15, 14, 16, ...Array.from({ length: ncol - 7 }, () => 16)],
      rows: rows.map((r) => (r.length ? pad(r) : r)),
      merges,
    });
  }


  return (
    <div className="page rep-page">
      <PageHeader
        title="Reports"
        subtitle="How much work was done between two dates, and where the elements stand."
        actions={
          <button className="btn" onClick={download}>
            Download Excel
          </button>
        }
      />

      <div className="filters card rep-filters">
        <label>
          From
          <input type="date" value={dates.from} onChange={(e) => setDates({ ...dates, from: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={dates.to} onChange={(e) => setDates({ ...dates, to: e.target.value })} />
        </label>
        {buildings.length > 1 && (
          <label>
            Building
            <select value={buildingId} onChange={(e) => (setBuildingId(e.target.value), setElementId(''))}>
              <option value="">All buildings</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Element type
          <select value={type} onChange={(e) => (setType(e.target.value as ElementType | ''), setElementId(''))}>
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {ELEMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          Element
          <select value={elementIdOk} onChange={(e) => setElementId(e.target.value)}>
            <option value="">All {type ? `${ELEMENT_TYPE_LABELS[type].toLowerCase()}s` : 'elements'} ({inScope.length})</option>
            {inScope.map((e) => (
              <option key={e.id} value={e.id}>
                {elementLabel(e)}
              </option>
            ))}
          </select>
        </label>
        <label className="rep-check">
          <input type="checkbox" checked={mode === 'with-pending'} onChange={(e) => setMode(e.target.checked ? 'with-pending' : 'approved')} />
          Also count work waiting for PMC approval
        </label>
        {filtered && (
          <button
            className="link"
            onClick={() => {
              setBuildingId('');
              setType('');
              setElementId('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {dateError && <div className="alert alert-warn">{dateError}</div>}

      {/* ---------- 1. work done between the dates ---------- */}
      <section className="dash-card">
        <div className="dash-card-head">
          <div>
            <h2>1. Work done</h2>
            <p>
              {periodText} · {scopeText} · {countText}
            </p>
          </div>
        </div>
        {summary.entries === 0 ? (
          <p className="rep-empty">
            No {mode === 'approved' ? 'approved ' : ''}work in these dates.
            {mode === 'approved' ? ' Tick "Also count work waiting for PMC approval", or choose other dates.' : ' Choose other dates.'}
          </p>
        ) : (
          <>
            <div className="rep-cards">
              {summary.activities.map((a) => (
                <div key={a.code} className="rep-card">
                  <div className="rep-card-value">
                    {formatQty(summary.totals[a.code])} <span>{UNIT_LABELS[a.unit] ?? a.unit}</span>
                  </div>
                  <div className="rep-card-name">{a.name}</div>
                </div>
              ))}
            </div>
            {!element && summary.byFloor.length > 1 && (
              <button className="link rep-more" onClick={() => setShowFloors(!showFloors)}>
                {showFloors ? 'Hide floor-wise split' : 'Show floor-wise split'}
              </button>
            )}
            {showFloors && !element && summary.byFloor.length > 1 && (
              <div className="dash-table-wrap">
                <table className="dash-table rep-table">
                  <thead>
                    <tr>
                      <th>Building – Floor</th>
                      {summary.activities.map((a) => (
                        <th key={a.code} className="num">
                          {a.name} <span className="rep-unit">{UNIT_LABELS[a.unit] ?? a.unit}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byFloor.map((g) => (
                      <tr key={g.key}>
                        <td>
                          <b>{g.label.join(' – ')}</b>
                        </td>
                        {summary.activities.map((a) => (
                          <td key={a.code} className="num">
                            {g.qty[a.code] ? formatQty(g.qty[a.code]) : <span className="muted">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>


      {/* ---------- 2. element status, as a report table ---------- */}
      <section className="dash-card">
        <div className="dash-card-head">
          <div>
            <h2>2. Element status</h2>
            <p>
              As of today · {scopeText} · {countText} · % = work done ÷ planned quantity
            </p>
          </div>
        </div>
        {statuses.length === 0 ? (
          <p className="rep-empty">No elements for these filters.</p>
        ) : !type && !element ? (
          <div className="dash-table-wrap">
            <table className="dash-table rep-table rep-status">
              <thead>
                <tr>
                  <th>Element type</th>
                  <th className="num">Total</th>
                  <th className="num">Complete</th>
                  <th className="num">In progress</th>
                  <th className="num">Not started</th>
                  {statusActs.map((a) => (
                    <th key={a.code} className="num">
                      {a.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statuses.map(({ type: t, s }) => (
                  <tr key={t} className="rep-click" onClick={() => (setType(t), setElementId(''))} title="Show these elements one by one">
                    <td>
                      <b>{ELEMENT_TYPE_LABELS[t]}</b>
                    </td>
                    <td className="num">{s.rows.length}</td>
                    <td className="num rep-n-done">{s.counts.complete || '—'}</td>
                    <td className="num rep-n-doing">{s.counts.going || '—'}</td>
                    <td className="num">{s.counts.notStarted || '—'}</td>
                    {statusActs.map((a) => (
                      <td key={a.code} className="num">
                        {pct(s.activityPercent[a.code])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{statuses.reduce((n, x) => n + x.s.rows.length, 0)}</td>
                  <td className="num">{statuses.reduce((n, x) => n + x.s.counts.complete, 0)}</td>
                  <td className="num">{statuses.reduce((n, x) => n + x.s.counts.going, 0)}</td>
                  <td className="num">{statuses.reduce((n, x) => n + x.s.counts.notStarted, 0)}</td>
                  {statusActs.map((a) => (
                    <td key={a.code} />
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          (() => {
            const s = statuses[0].s;
            const rows = element ? s.rows.filter((r) => r.element.id === element.id) : s.rows;
            return (
              <>
                {!element && (
                  <p className="rep-sum">
                    {s.rows.length} {ELEMENT_TYPE_LABELS[statuses[0].type].toLowerCase()}
                    {s.rows.length === 1 ? '' : 's'}: <b className="rep-n-done">{s.counts.complete} complete</b> · <b className="rep-n-doing">{s.counts.going} in progress</b> ·{' '}
                    <b>{s.counts.notStarted} not started</b>
                  </p>
                )}
                <div className="dash-table-wrap">
                  <table className="dash-table rep-table rep-status">
                    <thead>
                      <tr>
                        <th>Element</th>
                        <th>Stage</th>
                        <th>Started</th>
                        <th>Completed</th>
                        <th className="num">Days</th>
                        {s.activities.map((a) => (
                          <th key={a.code} className="num">
                            {a.name}
                          </th>
                        ))}
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.element.id}>
                          <td>
                            <b>{elementLabel(r.element)}</b>
                          </td>
                          <td className={`rep-stage-${tone(r.stage)}`}>{r.label}</td>
                          {(() => {
                            const d = datesOf(r.element, r.stage);
                            return (
                              <>
                                <td>{d.started ? fmtDay(d.started) : <span className="muted">—</span>}</td>
                                <td>{d.done ? fmtDay(d.done) : <span className="muted">—</span>}</td>
                                <td className="num">{d.days ?? <span className="muted">—</span>}</td>
                              </>
                            );
                          })()}
                          {s.activities.map((a) => (
                            <td key={a.code} className="num">
                              {pct(r.percent[a.code])}
                            </td>
                          ))}
                          <td className="num">
                            <button className="link" onClick={() => show(r.element.id)}>
                              Show in 3D
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()
        )}
        {!type && !element && statuses.length > 0 && <p className="rep-note">Click an element type to see its elements one by one.</p>}
      </section>

      {/* ---------- 3. plan vs actual ---------- */}
      <section className="dash-card">
        <div className="dash-card-head">
          <div>
            <h2>3. Plan vs actual</h2>
            <p>
              {periodText} · {scopeText} · submitted plans compared with what was reported
            </p>
          </div>
          <button className="link" onClick={() => go('planning')}>
            Open Planning
          </button>
        </div>
        {planRows.length === 0 ? (
          <p className="rep-empty">Nothing planned in these dates.</p>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-table rep-table rep-status">
                <thead>
                  <tr>
                    <th className="num">Planned</th>
                    <th className="num">Done on time</th>
                    <th className="num">Late</th>
                    <th className="num">Going on</th>
                    <th className="num">No work</th>
                    <th className="num">Not reported</th>
                    <th className="num">Still to come</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="num">
                      <b>{planRows.length}</b>
                    </td>
                    <td className="num rep-n-done">{planCounts.done}</td>
                    <td className="num rep-n-missed">{planCounts.late}</td>
                    <td className="num rep-n-doing">{planCounts.started}</td>
                    <td className="num">{planCounts['no-work']}</td>
                    <td className="num rep-n-missed">{planCounts.missed}</td>
                    <td className="num">{planCounts.pending}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="dash-table-wrap rep-plan-list">
              <table className="dash-table rep-table">
                <thead>
                  <tr>
                    <th>Element</th>
                    <th>Work</th>
                    <th>Planned</th>
                    <th>Started</th>
                    <th>Completed</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {planRows.map((r) => (
                    <tr key={r.plan.id}>
                      <td>
                        <b>{r.element ? elementLabel(r.element) : r.plan.elementId}</b>
                      </td>
                      <td>{r.activity?.name ?? r.plan.activityCode}</td>
                      <td className="nowrap">{fmtDay(r.plan.date)}{planEnd(r.plan) !== r.plan.date && ` – ${fmtDay(planEnd(r.plan))}`}</td>
                      <td className="nowrap">{r.actualStart ? fmtDay(r.actualStart) : <span className="muted">—</span>}</td>
                      <td className="nowrap">{r.actualDone ? fmtDay(r.actualDone) : <span className="muted">—</span>}</td>
                      <td>
                        <span className={`plan-res plan-res-${r.result}`}>{PLAN_RESULT_LABELS[r.result]}</span> <span className="muted small">{r.detail}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

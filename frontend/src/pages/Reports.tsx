import { useMemo, useState } from 'react';
import { EmptyState, PageHeader, Spinner } from '../components/ui';
import { formatQty } from '../domain/progress';
import {
  categoryStatus,
  elementLabel,
  ELEMENT_TYPE_LABELS,
  executiveSummary,
  presetRange,
  type CategoryStatus,
  type CountMode,
  type RangePreset,
} from '../domain/reports';
import { UNIT_LABELS, type ElementType } from '../domain/types';
import { todayISO } from '../domain/workflow';
import { downloadText, toCsv } from '../lib/download';
import { useApp } from '../state/AppContext';

const PERIODS: { id: RangePreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'last10', label: 'Last 10 days' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Choose dates' },
];

const fmtDay = (ymd: string) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const tone = (stage: string) => (stage === 'complete' ? 'done' : stage === 'not-started' || stage === 'no-plan' ? 'none' : 'doing');

/**
 * The executive report asked for in the boss meeting, on ONE page:
 *  1. how much work was done in a period (m³ concrete, kg steel, m² shuttering …);
 *  2. where each type of element stands ("Footing: 10 complete · 5 steel done · 2 on shuttering · rest not started").
 * Read only: it never changes any entry.
 */
export function Reports() {
  const { data, go, setSelection } = useApp();
  const [mode, setMode] = useState<CountMode>('approved');
  const [buildingId, setBuildingId] = useState('');
  const [preset, setPreset] = useState<RangePreset>('last10');
  const [custom, setCustom] = useState(() => presetRange('last10'));
  const [open, setOpen] = useState<{ type: ElementType; stage: string } | null>(null);
  const [showFloors, setShowFloors] = useState(false);

  const range = preset === 'custom' ? custom : presetRange(preset);
  const elements = useMemo(() => data?.elements ?? [], [data]);
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const activities = useMemo(() => data?.model?.document?.activities ?? [], [data]);
  const buildings = data?.model?.document?.buildings ?? [];

  const summary = useMemo(
    () => executiveSummary(elements, entries, activities, { from: range.from, to: range.to, buildingId, mode }),
    [elements, entries, activities, range.from, range.to, buildingId, mode],
  );
  const statuses = useMemo(() => {
    const present = new Set(elements.filter((e) => !buildingId || e.buildingId === buildingId).map((e) => e.type));
    return (Object.keys(ELEMENT_TYPE_LABELS) as ElementType[])
      .filter((t) => present.has(t))
      .map((t) => ({ type: t, s: categoryStatus(elements, entries, activities, t, mode, buildingId) }))
      .filter((x) => x.s.rows.length);
  }, [elements, entries, activities, mode, buildingId]);

  if (!data) return <Spinner />;
  if (!data.model)
    return (
      <div className="page">
        <PageHeader title="Reports" />
        <EmptyState title="No 3D model yet" action={<button className="btn btn-primary" onClick={() => go('models')}>Upload 3D + BOQ</button>}>
          Reports need the project's 3D model and BOQ.
        </EmptyState>
      </div>
    );

  const dateError = preset === 'custom' && custom.from && custom.to && custom.from > custom.to ? '"From" date is after "To" date.' : null;
  const periodText =
    !range.from && !range.to ? 'All time' : range.from === range.to ? fmtDay(range.from) : `${fmtDay(range.from) || 'Start'} – ${fmtDay(range.to) || 'today'}`;
  const buildingName = buildings.find((b) => b.id === buildingId)?.name ?? 'All buildings';
  const countText = mode === 'approved' ? 'approved work only' : 'approved + waiting for approval';

  function download() {
    const acts = summary.activities;
    const rows: (string | number)[][] = [
      ['PMC Report', data!.project.name],
      ['Building', buildingName],
      ['Counted', countText],
      [],
      [`Work done: ${periodText}`],
      ['Activity', 'Quantity', 'Unit'],
      ...acts.map((a) => [a.name, summary.totals[a.code] ?? 0, UNIT_LABELS[a.unit] ?? a.unit]),
      [],
      ['Work done by floor', '', ...acts.map((a) => `${a.name} (${UNIT_LABELS[a.unit] ?? a.unit})`)],
      ...summary.byFloor.map((g) => [...g.label, ...acts.map((a) => g.qty[a.code] ?? 0)]),
      [],
      ['Where each element type stands (today)'],
      ['Element type', 'Stage', 'Elements'],
      ...statuses.flatMap(({ type, s }) => s.buckets.map((b) => [ELEMENT_TYPE_LABELS[type], b.label, b.elements.length])),
      [],
      ['Element', 'Stage'],
      ...statuses.flatMap(({ s }) => s.rows.map((r) => [elementLabel(r.element), r.label])),
    ];
    downloadText(`pmc-report-${data!.project.id}-${todayISO()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  }

  return (
    <div className="page rep-page">
      <PageHeader
        title="Reports"
        subtitle="How much work was done, and where each type of element stands — on one page."
        actions={
          <button className="btn" onClick={download}>
            Download Excel (CSV)
          </button>
        }
      />

      <div className="rep-options">
          {buildings.length > 1 && (
            <label>
              Building{' '}
              <select value={buildingId} onChange={(e) => (setBuildingId(e.target.value), setOpen(null))}>
                <option value="">All buildings</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="rep-check">
            <input type="checkbox" checked={mode === 'with-pending'} onChange={(e) => setMode(e.target.checked ? 'with-pending' : 'approved')} />
            Also count work waiting for PMC approval
          </label>
      </div>

      {/* ---------- 1. work done in the period ---------- */}
      <section className="dash-card">
        <div className="dash-card-head rep-head">
          <div>
            <h2>1. Work done</h2>
            <p>
              {periodText} · {buildingName} · {countText}
            </p>
          </div>
          <div className="rep-periods" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.id} className={preset === p.id ? 'on' : ''} onClick={() => setPreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {preset === 'custom' && (
          <div className="rep-dates">
            <label>
              From <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label>
              To <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </label>
          </div>
        )}
        {dateError && <div className="alert alert-warn">{dateError}</div>}

        {summary.entries === 0 ? (
          <p className="rep-empty">
            No {mode === 'approved' ? 'approved ' : ''}work in this period.
            {mode === 'approved' ? ' Tick "Also count work waiting for PMC approval" above, or choose a longer period.' : ' Choose a longer period.'}
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
            {summary.byFloor.length > 1 && (
              <button className="link rep-more" onClick={() => setShowFloors(!showFloors)}>
                {showFloors ? 'Hide floor-wise split' : 'Show floor-wise split'}
              </button>
            )}
            {showFloors && summary.byFloor.length > 1 && (
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

      {/* ---------- 2. status of each element type ---------- */}
      <section className="dash-card">
        <div className="dash-card-head">
          <div>
            <h2>2. Where each element type stands</h2>
            <p>As of today · click a number to see those elements</p>
          </div>
        </div>
        {statuses.length === 0 ? (
          <p className="rep-empty">No elements in this building.</p>
        ) : (
          <div className="rep-types">
            {statuses.map(({ type, s }) => (
              <TypeRow
                key={type}
                type={type}
                s={s}
                openStage={open?.type === type ? open.stage : null}
                onOpen={(stage) => setOpen(open?.type === type && open.stage === stage ? null : { type, stage })}
                onShow={(id) => {
                  setSelection(new Set([id]));
                  go('workspace');
                }}
              />
            ))}
          </div>
        )}
        <p className="rep-legend">
          <span className="rep-dot rep-dot-done" /> Complete <span className="rep-dot rep-dot-doing" /> Work going on <span className="rep-dot rep-dot-none" /> Not started
        </p>
      </section>
    </div>
  );
}

function TypeRow({
  type,
  s,
  openStage,
  onOpen,
  onShow,
}: {
  type: ElementType;
  s: CategoryStatus;
  openStage: string | null;
  onOpen: (stage: string) => void;
  onShow: (elementId: string) => void;
}) {
  const total = s.rows.length;
  const name = ELEMENT_TYPE_LABELS[type];
  const opened = s.rows.filter((r) => r.stage === openStage);
  return (
    <div className="rep-type">
      <div className="rep-type-head">
        <div className="rep-type-name">
          {name}
          {total === 1 ? '' : 's'} <span>{total}</span>
        </div>
        <div className="rep-bar" aria-hidden>
          {s.buckets.map((b) => (
            <div key={b.stage} className={`rep-bar-${tone(b.stage)}`} style={{ flexGrow: b.elements.length }} />
          ))}
        </div>
      </div>
      <div className="rep-chips">
        {s.buckets.map((b) => (
          <button key={b.stage} className={`rep-chip rep-chip-${tone(b.stage)} ${openStage === b.stage ? 'on' : ''}`} onClick={() => onOpen(b.stage)}>
            <b>{b.elements.length}</b> {b.label}
          </button>
        ))}
      </div>
      {openStage && opened.length > 0 && (
        <ul className="rep-list">
          {opened.map((r) => (
            <li key={r.element.id}>
              <span>{elementLabel(r.element)}</span>
              <button className="link" onClick={() => onShow(r.element.id)}>
                Show in 3D
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

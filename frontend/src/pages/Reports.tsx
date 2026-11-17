import { useMemo, useState } from 'react';
import { EmptyState, PageHeader, Spinner } from '../components/ui';
import { formatQty } from '../domain/progress';
import {
  categoryStatus,
  elementLabel,
  ELEMENT_TYPE_LABELS,
  executiveSummary,
  presetRange,
  type CountMode,
  type RangePreset,
  type SummaryGroup,
} from '../domain/reports';
import { UNIT_LABELS, type ActivityDef, type ElementType } from '../domain/types';
import { todayISO } from '../domain/workflow';
import { downloadText, toCsv } from '../lib/download';
import { useApp } from '../state/AppContext';

type Tab = 'summary' | 'status';

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'last10', label: 'Last 10 days' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Choose dates' },
];

const unit = (a: ActivityDef) => UNIT_LABELS[a.unit] ?? a.unit;
const fmtDay = (ymd: string) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** Management reports: read only, they never change any entry. */
export function Reports() {
  const { data, go, setSelection } = useApp();
  const [tab, setTab] = useState<Tab>('summary');
  const [mode, setMode] = useState<CountMode>('approved');
  const [buildingId, setBuildingId] = useState('');
  const [preset, setPreset] = useState<RangePreset>('last10');
  const [custom, setCustom] = useState(() => presetRange('last10'));
  const [type, setType] = useState<ElementType | ''>('');
  const [openBucket, setOpenBucket] = useState<string | null>(null);

  const range = preset === 'custom' ? custom : presetRange(preset);
  const elements = useMemo(() => data?.elements ?? [], [data]);
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const activities = useMemo(() => data?.model?.document?.activities ?? [], [data]);
  const buildings = data?.model?.document?.buildings ?? [];

  const summary = useMemo(
    () => executiveSummary(elements, entries, activities, { from: range.from, to: range.to, buildingId, mode }),
    [elements, entries, activities, range.from, range.to, buildingId, mode],
  );

  const types = useMemo(() => {
    const present = new Set(elements.map((e) => e.type));
    return (Object.keys(ELEMENT_TYPE_LABELS) as ElementType[]).filter((t) => present.has(t));
  }, [elements]);
  const currentType: ElementType | '' = type && types.includes(type) ? type : (types[0] ?? '');
  const status = useMemo(
    () => (currentType ? categoryStatus(elements, entries, activities, currentType, mode, buildingId) : null),
    [elements, entries, activities, currentType, mode, buildingId],
  );

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
  const countText = mode === 'approved' ? 'Approved work only' : 'Approved + waiting for approval';

  function downloadSummary() {
    const acts = summary.activities;
    const head = (first: string[]) => [...first, ...acts.map((a) => `${a.name} (${unit(a)})`)];
    const line = (g: SummaryGroup) => [...g.label, ...acts.map((a) => g.qty[a.code] ?? 0)];
    const rows: (string | number)[][] = [
      ['Executive Summary', data!.project.name],
      ['Period', periodText],
      ['Building', buildingName],
      ['Counted', countText],
      [],
      head(['Total']),
      ['All', ...acts.map((a) => summary.totals[a.code] ?? 0)],
      [],
      head(['Building', 'Floor']),
      ...summary.byFloor.map(line),
      [],
      head(['Element type']),
      ...summary.byType.map(line),
    ];
    downloadText(`executive-summary-${data!.project.id}-${todayISO()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  }

  function downloadStatus() {
    if (!status || !currentType) return;
    const rows: (string | number)[][] = [
      [`${ELEMENT_TYPE_LABELS[currentType]} status`, data!.project.name],
      ['Building', buildingName],
      ['Counted', countText],
      [],
      ['Stage', 'Elements'],
      ...status.buckets.map((b) => [b.label, b.elements.length]),
      [],
      ['Element', 'Stage', ...status.activities.map((a) => `${a.name} %`)],
      ...status.rows.map((r) => [elementLabel(r.element), r.label, ...status.activities.map((a) => r.percent[a.code] ?? '—')]),
    ];
    downloadText(`${currentType}-status-${data!.project.id}-${todayISO()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  }

  const groupTable = (title: string, first: string[], groups: SummaryGroup[]) => (
    <section className="dash-card">
      <div className="dash-card-head">
        <div>
          <h2>{title}</h2>
        </div>
      </div>
      <div className="dash-table-wrap">
        <table className="dash-table rep-table">
          <thead>
            <tr>
              {first.map((h) => (
                <th key={h}>{h}</th>
              ))}
              {summary.activities.map((a) => (
                <th key={a.code} className="num">
                  {a.name}
                  <div className="muted small">{unit(a)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                {g.label.map((l, i) => (
                  <td key={i}>{i === 0 ? <b>{l}</b> : l}</td>
                ))}
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
    </section>
  );

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        subtitle="Short reports for management — how much work was done, and where each type of element stands. Reports only read data; they change nothing."
        actions={
          <button className="btn" onClick={tab === 'summary' ? downloadSummary : downloadStatus} disabled={tab === 'summary' ? !summary.entries : !status?.rows.length}>
            Download Excel (CSV)
          </button>
        }
      />

      <div className="rep-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'summary'} className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>
          Executive Summary
        </button>
        <button role="tab" aria-selected={tab === 'status'} className={tab === 'status' ? 'on' : ''} onClick={() => setTab('status')}>
          Status by Element Type
        </button>
      </div>

      <div className="filters card">
        {buildings.length > 1 && (
          <label>
            Building
            <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
              <option value="">All buildings</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {tab === 'summary' && (
          <label>
            Period
            <select value={preset} onChange={(e) => setPreset(e.target.value as RangePreset)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {tab === 'summary' && preset === 'custom' && (
          <>
            <label>
              From
              <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label>
              To
              <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </label>
          </>
        )}
        {tab === 'status' && (
          <label>
            Element type
            <select value={currentType} onChange={(e) => (setType(e.target.value as ElementType), setOpenBucket(null))}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {ELEMENT_TYPE_LABELS[t]}
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
      {dateError && <div className="alert alert-warn">{dateError}</div>}

      {tab === 'summary' ? (
        <>
          <p className="rep-period">
            <b>{periodText}</b> · {buildingName} · {countText}
            {summary.entries > 0 && (
              <>
                {' '}
                · work on {summary.days} day{summary.days === 1 ? '' : 's'}, {summary.elements} element{summary.elements === 1 ? '' : 's'}
              </>
            )}
          </p>
          {summary.entries === 0 ? (
            <EmptyState title="No work in this period">
              {mode === 'approved' ? 'Nothing approved in these dates. Tick "Also count work waiting for PMC approval", or choose a longer period.' : 'Choose a longer period.'}
            </EmptyState>
          ) : (
            <>
              <div className="rep-cards">
                {summary.activities.map((a) => (
                  <div key={a.code} className="rep-card">
                    <div className="rep-card-name">{a.name}</div>
                    <div className="rep-card-value">
                      {formatQty(summary.totals[a.code])} <span>{unit(a)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {groupTable('By building and floor', ['Building', 'Floor'], summary.byFloor)}
              {groupTable('By element type', ['Element type'], summary.byType)}
            </>
          )}
        </>
      ) : !status || status.rows.length === 0 ? (
        <EmptyState title="No elements">This building has no elements of this type.</EmptyState>
      ) : (
        <>
          <p className="rep-period">
            <b>{status.rows.length} {ELEMENT_TYPE_LABELS[currentType as ElementType].toLowerCase()}{status.rows.length === 1 ? '' : 's'}</b> · {buildingName} · {countText} · click a box to see the elements
          </p>
          <div className="rep-buckets">
            {status.buckets.map((b) => (
              <button
                key={b.stage}
                className={`rep-bucket rep-bucket-${b.stage === 'complete' ? 'done' : b.stage === 'not-started' || b.stage === 'no-plan' ? 'none' : 'doing'} ${openBucket === b.stage ? 'on' : ''}`}
                onClick={() => setOpenBucket(openBucket === b.stage ? null : b.stage)}
              >
                <span className="rep-bucket-n">{b.elements.length}</span>
                <span className="rep-bucket-label">{b.label}</span>
              </button>
            ))}
          </div>
          <section className="dash-card">
            <div className="dash-card-head">
              <div>
                <h2>{openBucket ? status.buckets.find((b) => b.stage === openBucket)?.label : 'All elements'}</h2>
                <p>% of the planned quantity done for each activity.</p>
              </div>
              {openBucket && (
                <button className="link" onClick={() => setOpenBucket(null)}>
                  Show all
                </button>
              )}
            </div>
            <div className="dash-table-wrap">
              <table className="dash-table rep-table">
                <thead>
                  <tr>
                    <th>Element</th>
                    <th>Stage</th>
                    {status.activities.map((a) => (
                      <th key={a.code} className="num">
                        {a.name}
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {status.rows
                    .filter((r) => !openBucket || r.stage === openBucket)
                    .map((r) => (
                      <tr key={r.element.id}>
                        <td>
                          <b>{elementLabel(r.element)}</b>
                        </td>
                        <td>{r.label}</td>
                        {status.activities.map((a) => (
                          <td key={a.code} className="num">
                            {r.percent[a.code] === null ? <span className="muted">—</span> : `${r.percent[a.code]}%`}
                          </td>
                        ))}
                        <td className="num">
                          <button
                            className="dash-view"
                            onClick={() => {
                              setSelection(new Set([r.element.id]));
                              go('workspace');
                            }}
                          >
                            Show in 3D
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

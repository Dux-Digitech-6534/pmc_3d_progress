import { useMemo, useState } from 'react';
import { EntryDetailsModal } from '../components/EntryDetailsModal';
import { MaterialTable } from '../components/MaterialTable';
import { MATERIALS, normsOf, projectMaterials, roundMaterial } from '../domain/materials';
import { downloadText } from '../lib/download';
import { EmptyState, PageHeader, ProgressBar, Spinner, StatusBadge } from '../components/ui';
import { ACTIVITY_STATUS_LABELS, formatQty, summarizeActivity, type ActivityStatus } from '../domain/progress';
import { ELEMENT_TYPES, UNIT_LABELS, type ProgressEntry } from '../domain/types';
import { todayISO } from '../domain/workflow';
import { STATUS_COLORS, TYPE_LABELS } from '../lib/colors';
import { useApp } from '../state/AppContext';

const ORDER: ActivityStatus[] = ['complete', 'in-progress', 'not-started', 'not-configured'];

export function Dashboard() {
  const { data, loadError, go, role } = useApp();
  const [viewing, setViewing] = useState<ProgressEntry | null>(null);

  const summaries = useMemo(() => {
    const acts = data?.model?.document?.activities ?? [];
    return acts.map((a) => summarizeActivity(data!.elements, a, data!.entries));
  }, [data]);

  const materials = useMemo(() => (data?.model ? projectMaterials(data.elements, data.entries, normsOf(data.model.document)) : null), [data]);

  if (loadError) return <EmptyState title="Could not load project data">{loadError}</EmptyState>;
  if (!data) return <Spinner />;

  const { project, model, elements, entries } = data;
  const today = todayISO();
  const pending = entries.filter((e) => e.status === 'Submitted');
  const todays = entries.filter((e) => e.date === today).sort((a, b) => a.elementCode.localeCompare(b.elementCode));
  const counts = ELEMENT_TYPES.map((t) => ({ t, n: elements.filter((e) => e.type === t).length }));

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        subtitle={
          model ? (
            <>
              {project.name} · {model.name} <b>{model.revision}</b> · progress uses <b>approved</b> entries only
            </>
          ) : (
            `${project.name} · no model imported yet`
          )
        }
        actions={
          <button className="btn btn-primary" onClick={() => go('workspace')}>
            Open 3D Workspace
          </button>
        }
      />

      {!model ? (
        <EmptyState
          title="No model for this project"
          action={
            <button className="btn btn-primary" onClick={() => go('models')}>
              Import a model
            </button>
          }
        />
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">Elements</div>
              <div className="stat-value">{elements.length}</div>
              <div className="stat-sub">
                {counts
                  .filter((c) => c.n)
                  .map((c) => `${c.n} ${TYPE_LABELS[c.t].toLowerCase()}${c.n === 1 ? '' : 's'}`)
                  .join(' · ')}
              </div>
            </div>
            <button className="stat stat-click" onClick={() => go('dpr')}>
              <div className="stat-label">Pending PMC review</div>
              <div className="stat-value">{pending.length}</div>
              <div className="stat-sub">{role === 'pmc-reviewer' ? 'Open the DPR list to review' : 'Submitted, not yet counted'}</div>
            </button>
            <div className="stat">
              <div className="stat-label">Reported today</div>
              <div className="stat-value">{todays.length}</div>
              <div className="stat-sub">entries dated {today}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Drafts / returned</div>
              <div className="stat-value">
                {entries.filter((e) => e.status === 'Draft').length} / {entries.filter((e) => e.status === 'Returned').length}
              </div>
              <div className="stat-sub">not counted as progress</div>
            </div>
          </div>

          <section className="card">
            <h2 className="card-title">Activity progress</h2>
            <p className="muted small">
              Each activity is measured in its own unit. There is deliberately no single "overall %" — kg, m² and m³ cannot be added together, and
              the weighting (cost, effort, milestones) has not been agreed with the client.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Activity</th>
                  <th className="num">Planned</th>
                  <th className="num">Approved</th>
                  <th className="num">Awaiting review</th>
                  <th style={{ width: '22%' }}>Progress</th>
                  <th>Elements by status</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr key={s.activity.code}>
                    <td>
                      <b>{s.activity.name}</b> <span className="muted small">({UNIT_LABELS[s.activity.unit]})</span>
                    </td>
                    <td className="num">{formatQty(s.planned, UNIT_LABELS[s.activity.unit])}</td>
                    <td className="num">{formatQty(s.approved, UNIT_LABELS[s.activity.unit])}</td>
                    <td className="num">{formatQty(s.pendingReview, UNIT_LABELS[s.activity.unit])}</td>
                    <td>
                      <ProgressBar percent={s.percent} status={s.percent === 100 ? 'complete' : s.approved > 0 ? 'in-progress' : 'not-started'} />
                      <span className="small">{s.percent === null ? 'Not configured' : `${s.percent}% of planned ${s.activity.name.toLowerCase()}`}</span>
                    </td>
                    <td>
                      <div className="status-counts">
                        {ORDER.filter((k) => s.counts[k] > 0).map((k) => (
                          <span key={k} className="pbadge">
                            <span className="dot" style={{ background: STATUS_COLORS[k] }} />
                            {s.counts[k]} {ACTIVITY_STATUS_LABELS[k].toLowerCase()}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {materials && (
            <section className="card">
              <div className="card-head-row">
                <h2 className="card-title">Material requirement</h2>
                <button
                  className="btn btn-small"
                  onClick={() => {
                    const head = ['Element type', 'Elements', ...MATERIALS.flatMap((m) => [`${m.label} planned (${m.unit})`, `${m.label} used (${m.unit})`])];
                    const line = (name: string, count: number | string, p: typeof materials.planned, u: typeof materials.used) =>
                      [name, count, ...MATERIALS.flatMap((m) => [roundMaterial(m.key, p[m.key]), roundMaterial(m.key, u[m.key])])].join(',');
                    const csv = [
                      head.join(','),
                      ...materials.rows.map((r) => line(TYPE_LABELS[r.type], r.count, r.planned, r.used)),
                      line('Total', elements.length, materials.planned, materials.used),
                    ].join('\n');
                    downloadText(`${project.id}-${model.revision}-materials.csv`, csv + '\n', 'text/csv');
                  }}
                >
                  Download CSV
                </button>
              </div>
              <p className="muted small">
                From the planned quantities of {model.name} {model.revision} and the norms approved with it (concrete {normsOf(model.document).concreteGrade}
                {normsOf(model.document).wastagePct ? `, ${normsOf(model.document).wastagePct}% wastage` : ''}). "Used" counts approved work only.
              </p>
              <MaterialTable planned={materials.planned} used={materials.used} />
              <h3 className="section-title" style={{ marginTop: 14 }}>Where it goes (planned)</h3>
              <div className="table-scroll">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Element type</th>
                      {MATERIALS.filter((m) => materials.planned[m.key] > 0).map((m) => (
                        <th key={m.key} className="num">
                          {m.label} <span className="muted small">({m.unit})</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {materials.rows.map((r) => (
                      <tr key={r.type}>
                        <td>
                          {TYPE_LABELS[r.type]} <span className="muted small">× {r.count}</span>
                        </td>
                        {MATERIALS.filter((m) => materials.planned[m.key] > 0).map((m) => (
                          <td key={m.key} className="num">
                            {r.planned[m.key] > 0 ? roundMaterial(m.key, r.planned[m.key]).toLocaleString('en-IN') : '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint">Per element: click it in the 3D Workspace.</p>
            </section>
          )}

          <div className="two-col">
            <section className="card">
              <h2 className="card-title">Today's reported work</h2>
              {todays.length === 0 ? (
                <p className="muted">Nothing reported for today yet.</p>
              ) : (
                <EntryTable rows={todays} onView={setViewing} />
              )}
            </section>
            <section className="card">
              <h2 className="card-title">Pending reviews</h2>
              {pending.length === 0 ? <p className="muted">No entries waiting for PMC review.</p> : <EntryTable rows={pending} onView={setViewing} />}
            </section>
          </div>
        </>
      )}
      {viewing && <EntryDetailsModal entry={viewing} activeModelKey={model?.key ?? null} onClose={() => setViewing(null)} />}
    </div>
  );
}

function EntryTable({ rows, onView }: { rows: ProgressEntry[]; onView: (e: ProgressEntry) => void }) {
  return (
    <table className="table compact">
      <thead>
        <tr>
          <th>Element</th>
          <th>Activity</th>
          <th className="num">Qty</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.id}>
            <td>{e.elementCode}</td>
            <td>{e.activityName}</td>
            <td className="num">{formatQty(e.quantity, UNIT_LABELS[e.unit])}</td>
            <td>
              <StatusBadge status={e.status} />
            </td>
            <td>
              <button className="link" onClick={() => onView(e)}>
                View
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

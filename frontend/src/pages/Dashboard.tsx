import { useMemo, useState, type ReactNode } from 'react';
import { EntryDetailsModal } from '../components/EntryDetailsModal';
import { EmptyState, Spinner, StatusBadge } from '../components/ui';
import { ACTIVITY_STATUS_LABELS, computeActivityProgress, formatQty, summarizeActivity, type ActivityStatus } from '../domain/progress';
import { ELEMENT_TYPES, UNIT_LABELS, type ProgressEntry } from '../domain/types';
import { todayISO } from '../domain/workflow';
import { STATUS_COLORS, TYPE_LABELS } from '../lib/colors';
import { useApp } from '../state/AppContext';

const ORDER: ActivityStatus[] = ['complete', 'in-progress', 'not-started', 'not-configured'];

const greeting = (h: number) => (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const ICONS = {
  cube: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  today: 'M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 9 2 2 4-4',
  draft: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  inbox: 'M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6l1-8Z',
};

export function Dashboard() {
  const { data, loadError, go, role, session } = useApp();
  const [viewing, setViewing] = useState<ProgressEntry | null>(null);

  const summaries = useMemo(() => {
    const acts = data?.model?.document?.activities ?? [];
    return acts.map((a) => summarizeActivity(data!.elements, a, data!.entries));
  }, [data]);

  // elements whose planned work is all approved
  const doneElements = useMemo(() => {
    const acts = data?.model?.document?.activities ?? [];
    return (data?.elements ?? []).filter((el) => {
      const used = acts.map((a) => computeActivityProgress(el, a, data!.entries)).filter((p) => p.planned !== null);
      return used.length > 0 && used.every((p) => p.status === 'complete');
    }).length;
  }, [data]);

  if (loadError) return <EmptyState title="Could not load project data">{loadError}</EmptyState>;
  if (!data) return <Spinner />;

  const { project, model, elements, entries } = data;
  const now = new Date();
  const today = todayISO();
  const firstName = (session?.fullName || '').trim().split(/\s+/)[0];
  const pending = entries.filter((e) => e.status === 'Submitted');
  const todays = entries.filter((e) => e.date === today).sort((a, b) => a.elementCode.localeCompare(b.elementCode));
  const drafts = entries.filter((e) => e.status === 'Draft').length;
  const returned = entries.filter((e) => e.status === 'Returned').length;
  const counts = ELEMENT_TYPES.map((t) => ({ t, n: elements.filter((e) => e.type === t).length })).filter((c) => c.n);
  const donePct = elements.length ? Math.round((doneElements / elements.length) * 100) : 0;

  return (
    <div className="page page-wide dash">
      <section className="dash-hero">
        <div className="dash-hero-text">
          <div className="dash-eyebrow">{now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
          <h1>
            {greeting(now.getHours())}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p>
            Here is how <b>{project.name}</b> is going{model ? '' : ' — no 3D + BOQ uploaded yet'}.
          </p>
          {model && (
            <div className="dash-chips">
              <span>{model.name}</span>
              <span>Revision {model.revision}</span>
              <span>Progress counts approved work only</span>
            </div>
          )}
          <div className="dash-hero-actions">
            <button className="btn dash-btn-light" onClick={() => go(model ? 'workspace' : 'models')}>
              {model ? 'Open 3D Workspace' : 'Upload 3D + BOQ'}
            </button>
            <button className="btn dash-btn-ghost" onClick={() => go('dpr')}>
              Daily Progress Reports
            </button>
          </div>
        </div>
        {model && (
          <div className="dash-ring" style={{ ['--p' as string]: donePct }} title={`${doneElements} of ${elements.length} elements have all their work approved`}>
            <div className="dash-ring-inner">
              <b>{donePct}%</b>
              <span>
                {doneElements} / {elements.length}
                <br />
                elements done
              </span>
            </div>
          </div>
        )}
      </section>

      {model && (
        <>
          <div className="dash-kpis">
            <Kpi tone="navy" icon={ICONS.cube} label="Elements" value={elements.length} onClick={() => go('workspace')}>
              {counts.map((c) => `${c.n} ${TYPE_LABELS[c.t].toLowerCase()}${c.n === 1 ? '' : 's'}`).join(' · ')}
            </Kpi>
            <Kpi tone="amber" icon={ICONS.clock} label="Pending PMC review" value={pending.length} onClick={() => go('dpr')}>
              {role === 'pmc-reviewer' ? 'Open the DPR list to review' : 'Submitted, not yet counted'}
            </Kpi>
            <Kpi tone="teal" icon={ICONS.today} label="Reported today" value={todays.length} onClick={() => go('dpr')}>
              Entries dated {now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
            </Kpi>
            <Kpi tone="rose" icon={ICONS.draft} label="Drafts / returned" value={`${drafts} / ${returned}`} onClick={() => go('dpr')}>
              Not counted as progress
            </Kpi>
          </div>

          <section className="dash-card">
            <div className="dash-card-head">
              <div>
                <h2>Activity progress</h2>
                <p>Each activity in its own unit (kg, m², m³) — approved work against the planned quantity.</p>
              </div>
            </div>
            <div className="dash-acts" style={{ ['--cols' as string]: summaries.length <= 4 ? summaries.length || 1 : summaries.length % 4 === 0 ? 4 : 3 }}>
              {summaries.map((s) => {
                const unit = UNIT_LABELS[s.activity.unit];
                const st: ActivityStatus = s.percent === 100 ? 'complete' : s.approved > 0 ? 'in-progress' : 'not-started';
                return (
                  <div key={s.activity.code} className={`dash-act dash-act-${st}`}>
                    <div className="dash-act-top">
                      <div>
                        <div className="dash-act-name">{s.activity.name}</div>
                        <div className="dash-act-unit">{unit}</div>
                      </div>
                      <div className="dash-act-pct">{s.percent === null ? '—' : `${s.percent}%`}</div>
                    </div>
                    <div className="dash-bar">
                      <div style={{ width: `${Math.min(s.percent ?? 0, 100)}%`, background: STATUS_COLORS[st] }} />
                    </div>
                    <div className="dash-act-figs">
                      <div>
                        <span>Planned</span>
                        <b>{formatQty(s.planned, unit)}</b>
                      </div>
                      <div>
                        <span>Approved</span>
                        <b>{formatQty(s.approved, unit)}</b>
                      </div>
                      <div className={s.pendingReview > 0 ? 'dash-wait' : ''}>
                        <span>In review</span>
                        <b>{formatQty(s.pendingReview, unit)}</b>
                      </div>
                    </div>
                    <div className="dash-act-status">
                      {ORDER.filter((k) => s.counts[k] > 0).map((k) => (
                        <span key={k}>
                          <i style={{ background: STATUS_COLORS[k] }} />
                          {s.counts[k]} {ACTIVITY_STATUS_LABELS[k].toLowerCase()}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="dash-two">
            <section className="dash-card">
              <div className="dash-card-head">
                <h2>
                  Today's reported work <span className="dash-count">{todays.length}</span>
                </h2>
              </div>
              {todays.length === 0 ? <Empty text="Nothing reported for today yet." /> : <EntryTable rows={todays} onView={setViewing} />}
            </section>
            <section className="dash-card">
              <div className="dash-card-head">
                <h2>
                  Pending reviews <span className="dash-count dash-count-amber">{pending.length}</span>
                </h2>
                {pending.length > 0 && (
                  <button className="link" onClick={() => go('dpr')}>
                    Open DPR list →
                  </button>
                )}
              </div>
              {pending.length === 0 ? <Empty text="No entries waiting for PMC review." /> : <EntryTable rows={pending} onView={setViewing} />}
            </section>
          </div>
        </>
      )}
      {viewing && <EntryDetailsModal entry={viewing} activeModelKey={model?.key ?? null} onClose={() => setViewing(null)} />}
    </div>
  );
}

function Kpi({
  tone,
  icon,
  label,
  value,
  onClick,
  children,
}: {
  tone: 'navy' | 'amber' | 'teal' | 'rose';
  icon: string;
  label: string;
  value: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={`dash-kpi dash-kpi-${tone}`} onClick={onClick}>
      <span className="dash-kpi-icon">
        <Icon d={icon} />
      </span>
      <span className="dash-kpi-body">
        <span className="dash-kpi-label">{label}</span>
        <span className="dash-kpi-value">{value}</span>
        <span className="dash-kpi-sub">{children}</span>
      </span>
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="dash-empty">
      <Icon d={ICONS.inbox} />
      <span>{text}</span>
    </div>
  );
}

function EntryTable({ rows, onView }: { rows: ProgressEntry[]; onView: (e: ProgressEntry) => void }) {
  return (
    <div className="dash-table-wrap">
      <table className="dash-table">
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
            <tr key={e.id} onClick={() => onView(e)}>
              <td>
                <b>{e.elementCode}</b>
              </td>
              <td>{e.activityName}</td>
              <td className="num">{formatQty(e.quantity, UNIT_LABELS[e.unit])}</td>
              <td>
                <StatusBadge status={e.status} />
              </td>
              <td className="num">
                <button
                  className="dash-view"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onView(e);
                  }}
                >
                  View
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

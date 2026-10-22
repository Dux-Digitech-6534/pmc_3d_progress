import { useEffect, useMemo, useState } from 'react';
import { EntryDetailsModal } from '../components/EntryDetailsModal';
import { EmptyState, fmtDate, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatQty } from '../domain/progress';
import { ENTRY_STATUSES, UNIT_LABELS, type EntryStatus, type ProgressEntry } from '../domain/types';
import { permissions, todayISO } from '../domain/workflow';
import { downloadText, toCsv } from '../lib/download';
import { useApp } from '../state/AppContext';

export function DprList() {
  const { data, repo, projects, role, go, setSelection } = useApp();
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [all, setAll] = useState<ProgressEntry[] | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | EntryStatus>('all');
  const [activity, setActivity] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [viewing, setViewing] = useState<ProgressEntry | null>(null);

  useEffect(() => {
    if (scope !== 'all') return;
    let alive = true;
    setAll(null);
    void repo.listAllProgressEntries().then((e) => alive && setAll(e));
    return () => {
      alive = false;
    };
  }, [scope, repo, data]);

  const source = scope === 'current' ? data?.allEntries ?? null : all;
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  const rows = useMemo(() => {
    if (!source) return [];
    const q = search.trim().toLowerCase();
    return source
      .filter(
        (e) =>
          (status === 'all' || e.status === status) &&
          (activity === 'all' || e.activityName === activity) &&
          (!from || e.date >= from) &&
          (!to || e.date <= to) &&
          (!q ||
            [e.id, e.elementCode, e.elementId, e.remarks, e.reviewRemarks ?? '', e.activityName, projectName(e.projectId)]
              .join(' ')
              .toLowerCase()
              .includes(q)),
      )
      .sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, search, status, activity, from, to, projects]);

  const activityNames = useMemo(() => [...new Set((source ?? []).map((e) => e.activityName))].sort(), [source]);
  const dateError = from && to && from > to ? '"From" date is after "To" date.' : null;

  function exportCsv() {
    const header = ['DPR ID', 'Date', 'Project', 'Project ID', 'Model', 'Revision', 'Element', 'Stable element ID', 'Element type', 'Activity', 'Quantity', 'Unit', 'Workflow status', 'Remarks', 'PMC review remarks', 'Batch', 'Photos'];
    const body = rows.map((e) => [
      e.id,
      e.date,
      projectName(e.projectId),
      e.projectId,
      e.modelId,
      e.modelRevision,
      e.elementCode,
      e.elementId,
      e.elementType,
      e.activityName,
      e.quantity,
      e.unit,
      e.status,
      e.remarks,
      e.reviewRemarks ?? '',
      e.batch?.id ?? '',
      e.photos.length,
    ]);
    downloadText(`pmc-dpr-${scope === 'current' ? data?.project.id ?? 'project' : 'all-projects'}-${todayISO()}.csv`, toCsv([header, ...body]), 'text/csv;charset=utf-8');
  }

  if (!data) return <Spinner />;

  return (
    <div className="page">
      <PageHeader
        title="Daily Progress Reports"
        subtitle={`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} shown${role === 'pmc-reviewer' ? ' · open a Submitted entry to approve or return it' : ''}`}
        actions={
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>
            Export CSV ({rows.length})
          </button>
        }
      />
      <div className="filters card">
        <label>
          Projects
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="current">Current: {data.project.name}</option>
            <option value="all">All projects</option>
          </select>
        </label>
        <label className="grow">
          Search
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Element, DPR ID, remarks…" />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All statuses</option>
            {ENTRY_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Activity
          <select value={activity} onChange={(e) => setActivity(e.target.value)}>
            <option value="all">All activities</option>
            {activityNames.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(search || status !== 'all' || activity !== 'all' || from || to) && (
          <button
            className="link"
            onClick={() => {
              setSearch('');
              setStatus('all');
              setActivity('all');
              setFrom('');
              setTo('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {dateError && <div className="alert alert-warn">{dateError}</div>}

      {!source ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No entries match">Try clearing the filters, or record work from the 3D Workspace.</EmptyState>
      ) : (
        <div className="card table-card">
          <table className="table dpr-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Project</th>
                <th>Element</th>
                <th>Activity</th>
                <th className="num">Quantity</th>
                <th>Status</th>
                <th>Remarks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{fmtDate(e.date)}</td>
                  <td>
                    {projectName(e.projectId)}
                    <div className="muted small">
                      {e.modelId} {e.modelRevision}
                    </div>
                  </td>
                  <td>
                    <b>{e.elementCode}</b>
                    <div className="muted small">{e.elementId}</div>
                  </td>
                  <td>{e.activityName}</td>
                  <td className="num nowrap">{formatQty(e.quantity, UNIT_LABELS[e.unit])}</td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="remarks-cell">
                    {e.remarks || <span className="muted">—</span>}
                    {e.reviewRemarks && <div className="review-note small">PMC: {e.reviewRemarks}</div>}
                  </td>
                  <td className="nowrap">
                    <button className="link" onClick={() => setViewing(e)}>
                      {permissions.canReview(role, e) ? 'Review' : 'View'}
                    </button>
                    {e.projectId === data.project.id && data.model?.key === e.modelKey && (
                      <button
                        className="link"
                        onClick={() => {
                          setSelection(new Set([e.elementId]));
                          go('workspace');
                        }}
                      >
                        Show in 3D
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && (
        <EntryDetailsModal
          entry={viewing}
          activeModelKey={viewing.projectId === data.project.id ? data.model?.key ?? null : null}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

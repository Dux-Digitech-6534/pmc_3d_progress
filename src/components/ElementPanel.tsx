import { useMemo, useState } from 'react';
import { computeActivityProgress, formatQty } from '../domain/progress';
import { ROLE_LABELS, UNIT_LABELS, type ActivityDef, type ElementRecord, type ProgressEntry } from '../domain/types';
import { permissions } from '../domain/workflow';
import { errorMessages } from '../data/repository';
import { AWAITING_COLOR, TYPE_LABELS } from '../lib/colors';
import { useApp } from '../state/AppContext';
import { BulkEntryForm } from './BulkEntryForm';
import { EntryDetailsModal } from './EntryDetailsModal';
import { EntryForm } from './EntryForm';
import { ConfirmDialog, EmptyState, fmtDate, ProgressBadge, ProgressBar, StatusBadge } from './ui';

/** Right-hand panel of the 3D workspace: details + history + entry form for the selection. */
export function ElementPanel({
  selected,
  activities,
  entries,
  allEntries,
  projectName,
  modelKey,
  onSelectOnly,
}: {
  selected: ElementRecord[];
  activities: ActivityDef[];
  entries: ProgressEntry[];
  allEntries: ProgressEntry[];
  projectName: string;
  modelKey: string;
  onSelectOnly: (id: string) => void;
}) {
  const { role } = useApp();
  const [editing, setEditing] = useState<ProgressEntry | null>(null);
  const [viewing, setViewing] = useState<ProgressEntry | null>(null);

  if (selected.length === 0) {
    return (
      <EmptyState title="No element selected">
        Click a footing, column, beam or slab in the 3D view, or pick one from the list. Hold <kbd>Ctrl</kbd>/<kbd>⌘</kbd> or use the
        checkboxes to select several elements for one entry.
      </EmptyState>
    );
  }

  if (selected.length > 1) {
    return (
      <div className="panel-scroll">
        <div className="panel-section">
          <h2 className="panel-title">{selected.length} elements selected</h2>
          <div className="chips">
            {selected.map((e) => (
              <button key={e.id} className="chip" onClick={() => onSelectOnly(e.id)} title="Show only this element" aria-label={`Show only ${e.code}`}>
                {e.code}
              </button>
            ))}
          </div>
        </div>
        <div className="panel-section">
          <h3 className="section-title">Record one activity for the selection</h3>
          {permissions.canCreate(role) ? (
            <BulkEntryForm elements={selected} activities={activities} entries={entries} onDone={() => undefined} />
          ) : (
            <p className="muted">{ROLE_LABELS[role]} can view progress only. Switch to Site Engineer to record work (demo role switch).</p>
          )}
        </div>
      </div>
    );
  }

  const el = selected[0];
  return (
    <div className="panel-scroll">
      <ElementSummary element={el} activities={activities} entries={entries} projectName={projectName} />
      <History
        element={el}
        entries={entries}
        olderCount={allEntries.filter((e) => e.elementId === el.id && e.modelKey !== modelKey).length}
        onView={setViewing}
        onEdit={setEditing}
      />
      <div className="panel-section">
        <h3 className="section-title">{editing ? `Edit ${editing.id} (${editing.status})` : 'Daily progress entry'}</h3>
        {permissions.canCreate(role) ? (
          <EntryForm element={el} activities={activities} entries={entries} editing={editing} onDone={() => setEditing(null)} />
        ) : (
          <p className="muted">
            {role === 'owner'
              ? 'Owner view: progress shown here uses approved entries only.'
              : 'PMC Reviewer: open a Submitted entry in the history above (or in Daily Progress Reports) to approve or return it.'}
          </p>
        )}
      </div>
      {viewing && (
        <EntryDetailsModal
          entry={viewing}
          activeModelKey={modelKey}
          onClose={() => setViewing(null)}
          onEdit={(e) => {
            setViewing(null);
            setEditing(e);
          }}
        />
      )}
    </div>
  );
}

function ElementSummary({
  element: el,
  activities,
  entries,
  projectName,
}: {
  element: ElementRecord;
  activities: ActivityDef[];
  entries: ProgressEntry[];
  projectName: string;
}) {
  const { role } = useApp();
  const progress = useMemo(() => activities.map((a) => computeActivityProgress(el, a, entries)).filter((p) => p.status !== 'not-applicable'), [activities, el, entries]);
  const waiting = role !== 'owner' && progress.some((p) => p.pendingReview > 0);
  return (
    <div className="panel-section">
      <div className="el-head">
        <h2 className="panel-title" data-testid="selected-element-code">
          {el.code}
        </h2>
        <span className={`type-tag type-${el.type}`}>{TYPE_LABELS[el.type]}</span>
      </div>
      <dl className="kv">
        <dt>Stable ID</dt>
        <dd>
          <code>{el.id}</code>
        </dd>
        <dt>Project</dt>
        <dd>{projectName}</dd>
        <dt>Building / level</dt>
        <dd>
          {el.buildingName} · {el.levelName}
        </dd>
        <dt>Model revision</dt>
        <dd>
          {el.modelId} <b>{el.modelRevision}</b>
        </dd>
        <dt>Size (W×H×D)</dt>
        <dd>{el.geometry.size.map((n) => n.toFixed(2)).join(' × ')} m</dd>
      </dl>
      {el.notes && <div className="alert alert-info small">{el.notes}</div>}

      <table className="table act-table">
        <thead>
          <tr>
            <th>Activity</th>
            <th className="num">Planned</th>
            <th className="num">Approved</th>
            <th className="num">Remaining</th>
          </tr>
        </thead>
        <tbody>
          {progress.map((p) => (
            <tr key={p.activityCode}>
              <td>
                <div className="act-name">{p.activityName}</div>
                <ProgressBar percent={p.percent} status={p.status} />
                <div className="act-status">
                  {role !== 'owner' && p.pendingReview > 0 && p.status !== 'complete' ? (
                    <span className="pbadge" title="Submitted, waiting for PMC approval — not counted yet">
                      <span className="dot" style={{ background: AWAITING_COLOR }} aria-hidden />
                      Awaiting approval
                    </span>
                  ) : (
                    <ProgressBadge status={p.status} />
                  )}
                  {p.percent !== null && <span className="small"> {p.percent}%</span>}
                  {p.pendingReview > 0 && <span className="small muted"> · {formatQty(p.pendingReview)} awaiting review</span>}
                </div>
              </td>
              <td className="num">{p.planned === null ? <span className="muted">Not configured</span> : formatQty(p.planned, UNIT_LABELS[p.unit])}</td>
              <td className="num">{formatQty(p.approved, UNIT_LABELS[p.unit])}</td>
              <td className="num">{formatQty(p.remaining, p.remaining === null ? undefined : UNIT_LABELS[p.unit])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {waiting && (
        <div className="alert alert-info small">
          Work on {el.code} has been submitted and is <b>waiting for PMC approval</b>. It is counted (and the 3D colour changes) only after the PMC Reviewer
          approves it{role === 'site-engineer' ? ' — switch Demo role to PMC Reviewer to approve it in this demo.' : ' — use “Approve all submitted” below, or Review each entry.'}
        </div>
      )}
      <p className="hint">Progress = approved quantity ÷ planned quantity, per activity. Drafts, submitted and returned entries are not counted.</p>
    </div>
  );
}

function History({
  element,
  entries,
  olderCount,
  onView,
  onEdit,
}: {
  element: ElementRecord;
  entries: ProgressEntry[];
  olderCount: number;
  onView: (e: ProgressEntry) => void;
  onEdit: (e: ProgressEntry) => void;
}) {
  const { role, repo, notify, refresh } = useApp();
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = entries
    .filter((e) => e.elementId === element.id)
    .sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)));
  const submitted = list.filter((e) => permissions.canReview(role, e)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  async function approveAll() {
    setBusy(true);
    const failed: string[] = [];
    let ok = 0;
    for (const e of submitted) {
      try {
        await repo.reviewProgressEntry(e.id, 'approve', '', role);
        ok++;
      } catch (err) {
        failed.push(`${e.id}: ${errorMessages(err).join(' ')}`);
      }
    }
    setBusy(false);
    setConfirmAll(false);
    await refresh();
    if (ok) notify(`${ok} entr${ok === 1 ? 'y' : 'ies'} for ${element.code} approved — progress updated.`);
    if (failed.length) notify(`Not approved: ${failed.join(' | ')}`, 'error');
  }

  return (
    <div className="panel-section">
      <div className="history-head">
        <h3 className="section-title">Progress history ({list.length})</h3>
        {submitted.length > 0 && (
          <button className="btn btn-small btn-primary" disabled={busy} onClick={() => setConfirmAll(true)}>
            Approve all submitted ({submitted.length})
          </button>
        )}
      </div>
      {confirmAll && (
        <ConfirmDialog
          title={`Approve ${submitted.length} entr${submitted.length === 1 ? 'y' : 'ies'} for ${element.code}?`}
          message={
            <>
              <ul>
                {submitted.map((e) => (
                  <li key={e.id}>
                    {fmtDate(e.date)} · {e.activityName} {formatQty(e.quantity, UNIT_LABELS[e.unit])} {e.remarks ? `— ${e.remarks}` : ''}
                  </li>
                ))}
              </ul>
              <p className="muted small">Approve only what you have checked on site. Approved entries count towards progress and cannot be edited.</p>
            </>
          }
          confirmLabel="Approve all"
          busy={busy}
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => void approveAll()}
        />
      )}
      {list.length === 0 ? (
        <p className="muted small">No entries yet for {element.code} on this revision.</p>
      ) : (
        <ul className="history">
          {list.map((e) => (
            <li key={e.id}>
              <div className="history-main">
                <StatusBadge status={e.status} />
                <span>
                  <b>{e.activityName}</b> {formatQty(e.quantity, UNIT_LABELS[e.unit])}
                </span>
                <span className="muted small">{fmtDate(e.date)}</span>
              </div>
              {(e.remarks || e.reviewRemarks) && (
                <div className="small history-remarks">
                  {e.remarks}
                  {e.reviewRemarks && <div className="review-note">PMC: {e.reviewRemarks}</div>}
                </div>
              )}
              <div className="history-actions">
                <button className="link" onClick={() => onView(e)}>
                  {permissions.canReview(role, e) ? 'Review' : 'View'}
                </button>
                {permissions.canEdit(role, e) && (
                  <button className="link" onClick={() => onEdit(e)}>
                    Edit
                  </button>
                )}
                <span className="muted small">{e.id}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {olderCount > 0 && (
        <p className="hint">{olderCount} older entr{olderCount === 1 ? 'y' : 'ies'} recorded on a previous model revision (kept in history, not counted here).</p>
      )}
    </div>
  );
}

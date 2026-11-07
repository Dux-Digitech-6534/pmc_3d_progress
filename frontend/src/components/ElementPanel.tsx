import { IS_FRAPPE } from '../config';
import { useMemo, useState } from 'react';
import { addMaterials, approvedOf, emptyMaterials, materialsFor, normsOf, plannedOf } from '../domain/materials';
import { computeActivityProgress, formatQty, roundQty, sameModelFamily } from '../domain/progress';
import { ROLE_LABELS, UNIT_LABELS, type ActivityDef, type ElementRecord, type ProgressEntry } from '../domain/types';
import { permissions } from '../domain/workflow';
import { errorMessages } from '../data/repository';
import { AWAITING_COLOR, TYPE_LABELS } from '../lib/colors';
import { useApp } from '../state/AppContext';
import { EntryDetailsModal } from './EntryDetailsModal';
import { EntryForm } from './EntryForm';
import { MaterialTable } from './MaterialTable';
import { DraftEntries } from './DraftEntries';
import { ReturnEntriesButton } from './ReturnEntries';
import { WorkDoneForm } from './WorkDoneForm';
import { ConfirmDialog, EmptyState, fmtDate, ProgressBadge, ProgressBar, StatusBadge } from './ui';

/** Right-hand panel of the 3D workspace: details + history + entry form for the selection. */
export function ElementPanel({
  selected,
  activities,
  entries,
  allEntries,
  projectName,
  modelKey,
  onOpen,
  detailsOnly,
}: {
  selected: ElementRecord[];
  activities: ActivityDef[];
  entries: ProgressEntry[];
  allEntries: ProgressEntry[];
  projectName: string;
  modelKey: string;
  onOpen: (id: string) => void;
  /** One element's details and history only — the work done form is for the ticked elements. */
  detailsOnly?: boolean;
}) {
  const { role } = useApp();
  const [editing, setEditing] = useState<ProgressEntry | null>(null);
  const [viewing, setViewing] = useState<ProgressEntry | null>(null);

  if (selected.length === 0) {
    return (
      <EmptyState title="No element selected">
        Open a type above (Footing, Column …) and select the elements, or click them in the 3D view (click again to unselect) — then
        mark the work that is done.
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
              <button key={e.id} className="chip" onClick={() => onOpen(e.id)} title="Show details" aria-label={`Details of ${e.code}`}>
                {e.code}
              </button>
            ))}
          </div>
        </div>
        <ApproveTicked elements={selected} entries={entries} />
        <DraftEntries elements={selected} entries={entries} />
        <SelectionTotals elements={selected} activities={activities} entries={entries} />
        <div className="panel-section">
          <h3 className="section-title">Work done</h3>
          {permissions.canCreate(role) ? (
            <WorkDoneForm elements={selected} activities={activities} entries={entries} />
          ) : (
            <p className="muted">{ROLE_LABELS[role]} can view progress only. {IS_FRAPPE ? 'A PMC Site Engineer records work.' : 'Switch to Site Engineer to record work (demo role switch).'}</p>
          )}
        </div>
      </div>
    );
  }

  const el = selected[0];
  return (
    <div className="panel-scroll">
      <ElementSummary element={el} activities={activities} entries={entries} projectName={projectName} />
      <DraftEntries elements={[el]} entries={entries} />
      <History
        element={el}
        entries={entries}
        olderCount={allEntries.filter((e) => e.elementId === el.id && !sameModelFamily(e.modelKey, modelKey)).length}
        onView={setViewing}
        onEdit={setEditing}
      />
      {(!detailsOnly || editing) && (
      <div className="panel-section">
        <h3 className="section-title">{editing ? `Edit ${editing.id} (${editing.status})` : 'Work done'}</h3>
        {permissions.canCreate(role) ? (
          editing ? (
            <EntryForm element={el} activities={activities} entries={entries} editing={editing} onDone={() => setEditing(null)} />
          ) : (
            <WorkDoneForm elements={[el]} activities={activities} entries={entries} />
          )
        ) : (
          <p className="muted">
            {role === 'owner'
              ? 'Owner view: progress shown here uses approved entries only.'
              : 'PMC Reviewer: open a Submitted entry in the history above (or in Daily Progress Reports) to approve or return it.'}
          </p>
        )}
      </div>
      )}
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

/** PMC Reviewer: approve every submitted entry of the ticked elements in one go. */
function ApproveTicked({ elements, entries }: { elements: ElementRecord[]; entries: ProgressEntry[] }) {
  const { role, repo, notify, refresh } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = new Set(elements.map((e) => e.id));
  // activities the reviewer leaves out (all are approved unless unselected)
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const all = entries
    .filter((e) => ids.has(e.elementId) && permissions.canReview(role, e))
    .sort((a, b) => a.elementCode.localeCompare(b.elementCode) || a.createdAt.localeCompare(b.createdAt));
  const acts = [...new Map(all.map((e) => [e.activityCode, e.activityName])).entries()];
  const submitted = acts.length > 1 ? all.filter((e) => !skipped.has(e.activityCode)) : all;
  if (!all.length) return null;

  async function approveAll() {
    setBusy(true);
    const failed: string[] = [];
    let ok = 0;
    for (const e of submitted) {
      try {
        await repo.reviewProgressEntry(e.id, 'approve', '', role);
        ok++;
      } catch (err) {
        failed.push(`${e.elementCode} ${e.id}: ${errorMessages(err).join(' ')}`);
      }
    }
    setBusy(false);
    setConfirm(false);
    setSkipped(new Set());
    await refresh();
    if (ok) notify(`${ok} entr${ok === 1 ? 'y' : 'ies'} of ${elements.length} selected elements approved — progress updated.`);
    if (failed.length) notify(`Not approved: ${failed.join(' | ')}`, 'error');
  }

  return (
    <div className="panel-section approve-ticked">
      <div className="history-head">
        <span>
          <b>{all.length}</b> submitted entr{all.length === 1 ? 'y' : 'ies'} on the selected elements
        </span>
        <span className="history-btns">
          <ReturnEntriesButton entries={submitted} onDone={() => setSkipped(new Set())} />
          <button className="btn btn-small btn-primary" disabled={busy || !submitted.length} onClick={() => setConfirm(true)}>
            {submitted.length === all.length ? `Approve all submitted (${all.length})` : `Approve selected (${submitted.length})`}
          </button>
        </span>
      </div>
      {acts.length > 1 && (
        <div className="approve-acts" role="group" aria-label="Activities to approve">
          {acts.map(([code, name]) => (
            <label key={code} className="check">
              <input
                type="checkbox"
                checked={!skipped.has(code)}
                onChange={() =>
                  setSkipped((s) => {
                    const next = new Set(s);
                    if (next.has(code)) next.delete(code);
                    else next.add(code);
                    return next;
                  })
                }
              />{' '}
              {name} ({all.filter((e) => e.activityCode === code).length})
            </label>
          ))}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Approve ${submitted.length} entr${submitted.length === 1 ? 'y' : 'ies'}?`}
          message={
            <>
              <ul className="approve-list">
                {submitted.map((e) => (
                  <li key={e.id}>
                    <b>{e.elementCode}</b> · {e.activityName} {formatQty(e.quantity, UNIT_LABELS[e.unit])} · {fmtDate(e.date)}
                    {e.remarks ? ` — ${e.remarks}` : ''}
                  </li>
                ))}
              </ul>
              <p className="muted small">Approve only what you have checked on site. Approved entries count towards progress; an approval given by mistake can be taken back from the entry (Withdraw approval, with a reason).</p>
            </>
          }
          confirmLabel={submitted.length === all.length ? 'Approve all' : 'Approve selected'}
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void approveAll()}
        />
      )}
    </div>
  );
}

/** Totals for a multi-selection: planned / approved per activity and the planned material. */
function SelectionTotals({ elements, activities, entries }: { elements: ElementRecord[]; activities: ActivityDef[]; entries: ProgressEntry[] }) {
  const { data } = useApp();
  const norms = normsOf(data?.model?.document);
  const rows = useMemo(
    () =>
      activities
        .map((a) => {
          let planned = 0;
          let approved = 0;
          let pending = 0;
          let count = 0;
          for (const el of elements) {
            const p = computeActivityProgress(el, a, entries);
            if (p.planned === null) continue;
            count++;
            planned += p.planned;
            approved += Math.min(p.approved, p.planned);
            pending += p.pendingReview;
          }
          return { a, count, planned: roundQty(planned), approved: roundQty(approved), pending: roundQty(pending) };
        })
        .filter((r) => r.count > 0),
    [activities, elements, entries],
  );
  const planned = elements.reduce((m, el) => addMaterials(m, materialsFor(plannedOf(el), norms)), emptyMaterials());
  const used = elements.reduce((m, el) => addMaterials(m, materialsFor(approvedOf(el, entries), norms)), emptyMaterials());
  return (
    <div className="panel-section">
      <h3 className="section-title">Total of the selection</h3>
      {rows.length === 0 ? (
        <p className="muted small">No planned quantities for these elements.</p>
      ) : (
        <table className="table act-table" data-testid="selection-totals">
          <thead>
            <tr>
              <th>Activity</th>
              <th className="num">Planned</th>
              <th className="num">Done</th>
              <th className="num">%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.a.code}>
                <td>
                  {r.a.name}
                  {r.count < elements.length && <span className="muted small"> ({r.count})</span>}
                  {r.pending > 0 && <div className="small muted">{formatQty(r.pending, UNIT_LABELS[r.a.unit])} awaiting approval</div>}
                </td>
                <td className="num">{formatQty(r.planned, UNIT_LABELS[r.a.unit])}</td>
                <td className="num">{formatQty(r.approved, UNIT_LABELS[r.a.unit])}</td>
                <td className="num">{r.planned > 0 ? Math.round((r.approved / r.planned) * 100) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <MaterialTable planned={planned} used={used} compact />
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
  const { role, data } = useApp();
  const norms = normsOf(data?.model?.document);
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
          approves it{role === 'site-engineer' ? (IS_FRAPPE ? '.' : ' — switch Demo role to PMC Reviewer to approve it in this demo.') : ' — use “Approve all submitted” below, or Review each entry.'}
        </div>
      )}
      <p className="hint">Progress = approved quantity ÷ planned quantity, per activity. Drafts, submitted and returned entries are not counted.</p>
      <h3 className="section-title" style={{ marginTop: 12 }}>Material</h3>
      <MaterialTable planned={materialsFor(plannedOf(el), norms)} used={materialsFor(approvedOf(el, entries), norms)} compact />
      <p className="hint">
        Concrete {norms.concreteGrade}
        {norms.wastagePct ? `, ${norms.wastagePct}% wastage` : ''} — norms set with the model planning.
      </p>
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
  const reviewable = list.filter((e) => permissions.canReview(role, e)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // entries the reviewer selected; none selected = approve all submitted
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const chosen = reviewable.filter((e) => picked.has(e.id));
  const submitted = chosen.length ? chosen : reviewable;

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
    setPicked(new Set());
    await refresh();
    if (ok) notify(`${ok} entr${ok === 1 ? 'y' : 'ies'} for ${element.code} approved — progress updated.`);
    if (failed.length) notify(`Not approved: ${failed.join(' | ')}`, 'error');
  }

  return (
    <div className="panel-section">
      <div className="history-head">
        <h3 className="section-title">Progress history ({list.length})</h3>
        {reviewable.length > 0 && (
          <span className="history-btns">
            <ReturnEntriesButton entries={submitted} onDone={() => setPicked(new Set())} />
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => setConfirmAll(true)}>
              {chosen.length ? `Approve selected (${chosen.length})` : `Approve all submitted (${reviewable.length})`}
            </button>
          </span>
        )}
      </div>
      {reviewable.length > 1 && <p className="hint">Select entries below to approve or return only those; with none selected the buttons act on all submitted.</p>}
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
              <p className="muted small">Approve only what you have checked on site. Approved entries count towards progress; an approval given by mistake can be taken back from the entry (Withdraw approval, with a reason).</p>
            </>
          }
          confirmLabel={chosen.length ? 'Approve selected' : 'Approve all'}
          busy={busy}
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => void approveAll()}
        />
      )}
      {list.length === 0 ? (
        <p className="muted small">No entries yet for {element.code}.</p>
      ) : (
        <ul className="history">
          {list.map((e) => (
            <li key={e.id}>
              <div className="history-main">
                {reviewable.length > 1 && permissions.canReview(role, e) && (
                  <input
                    type="checkbox"
                    checked={picked.has(e.id)}
                    aria-label={`Select ${e.activityName} ${e.id} to approve`}
                    onChange={() =>
                      setPicked((s) => {
                        const next = new Set(s);
                        if (next.has(e.id)) next.delete(e.id);
                        else next.add(e.id);
                        return next;
                      })
                    }
                  />
                )}
                <StatusBadge status={e.status} />
                <span>
                  <b>{e.activityName}</b> {formatQty(e.quantity, UNIT_LABELS[e.unit])}
                </span>
                <span className="muted small">{fmtDate(e.date)}</span>
                {e.modelRevision !== element.modelRevision && (
                  <span className="muted small" title="Recorded on an earlier revision of this model; still counted">
                    · {e.modelRevision}
                  </span>
                )}
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
        <p className="hint">{olderCount} older entr{olderCount === 1 ? 'y' : 'ies'} recorded on another model (kept in history, not counted here).</p>
      )}
    </div>
  );
}

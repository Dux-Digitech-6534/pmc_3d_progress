import { IS_FRAPPE } from '../config';
import { useRef, useState, type ReactNode } from 'react';
import { errorMessages } from '../data/repository';
import { formatQty } from '../domain/progress';
import { ROLE_LABELS, UNIT_LABELS, type ProgressEntry } from '../domain/types';
import { permissions, STATUS_DESCRIPTIONS } from '../domain/workflow';
import { useApp } from '../state/AppContext';
import { StoredPhoto } from './Photos';
import { ConfirmDialog, ErrorList, fmtDate, fmtDateTime, Modal, StatusBadge } from './ui';

const BATCH_MODE_LABELS = {
  'per-element': 'Quantity per element',
  'total-manual': 'Total, allocated manually',
  'total-equal': 'Total, split equally',
} as const;

/** Full DPR line details plus the workflow actions allowed for the current demo role. */
export function EntryDetailsModal({
  entry,
  activeModelKey,
  onClose,
  onEdit,
}: {
  entry: ProgressEntry;
  activeModelKey: string | null;
  onClose: () => void;
  onEdit?: (e: ProgressEntry) => void;
}) {
  const { repo, role, notify, refresh } = useApp();
  const [remarks, setRemarks] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inFlight = useRef(false);
  const oldRevision = activeModelKey !== null && entry.modelKey !== activeModelKey;

  async function run(label: string, fn: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErrors([]);
    try {
      await fn();
      notify(label);
      await refresh();
      onClose();
    } catch (e) {
      setErrors(errorMessages(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const canReview = permissions.canReview(role, entry) && !oldRevision;

  return (
    <>
      <Modal
        title={`${entry.id} — ${entry.elementCode} ${entry.activityName}`}
        onClose={onClose}
        wide
        footer={
          <>
            {permissions.canDelete(role, entry) && (
              <button className="btn btn-danger-outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete draft
              </button>
            )}
            <span className="spacer" />
            {onEdit && permissions.canEdit(role, entry) && !oldRevision && (
              <button className="btn" disabled={busy} onClick={() => onEdit(entry)}>
                Edit
              </button>
            )}
            {permissions.canSubmit(role, entry) && !oldRevision && (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => run(`${entry.id} submitted for PMC review.`, () => repo.submitProgressEntry(entry.id, role))}
              >
                Submit for review
              </button>
            )}
            {canReview && (
              <>
                <button
                  className="btn btn-warn"
                  disabled={busy}
                  onClick={() => run(`${entry.id} returned to the site engineer.`, () => repo.reviewProgressEntry(entry.id, 'return', remarks, role))}
                >
                  Return
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => run(`${entry.id} approved — progress updated.`, () => repo.reviewProgressEntry(entry.id, 'approve', remarks, role))}
                >
                  Approve
                </button>
              </>
            )}
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </>
        }
      >
        {oldRevision && (
          <div className="alert alert-info">
            Recorded on model revision <b>{entry.modelRevision}</b>, which is no longer active. It is kept as history and is not transferred to the
            current revision.
          </div>
        )}
        <div className="detail-grid">
          <Field label="Status">
            <StatusBadge status={entry.status} /> <span className="muted small">{STATUS_DESCRIPTIONS[entry.status]}</span>
          </Field>
          <Field label="Date">{fmtDate(entry.date)}</Field>
          <Field label="Element">
            {entry.elementCode} <span className="muted small">({entry.elementId}, {entry.elementType})</span>
          </Field>
          <Field label="Activity">{entry.activityName}</Field>
          <Field label="Quantity">
            <b>{formatQty(entry.quantity, UNIT_LABELS[entry.unit])}</b>
          </Field>
          <Field label="Project / model">
            {entry.projectId} · {entry.modelId} {entry.modelRevision}
          </Field>
          {entry.batch && (
            <Field label="Multi-element entry">
              {entry.batch.id}: {BATCH_MODE_LABELS[entry.batch.mode]} ·{' '}
              {entry.batch.total !== undefined
                ? `total ${formatQty(entry.batch.total, UNIT_LABELS[entry.unit])} across ${entry.batch.elementCount} elements`
                : `${formatQty(entry.batch.perElement ?? null, UNIT_LABELS[entry.unit])} for each of ${entry.batch.elementCount} elements`}
            </Field>
          )}
          <Field label="Remarks">{entry.remarks || <span className="muted">—</span>}</Field>
          {entry.reviewRemarks && <Field label="PMC review remarks">{entry.reviewRemarks}</Field>}
        </div>

        {entry.photos.length > 0 && (
          <>
            <h3 className="section-title">{IS_FRAPPE ? 'Photos' : 'Photos (stored in this browser)'}</h3>
            <div className="thumbs">
              {entry.photos.map((p) => (
                <div className="thumb" key={p.id}>
                  <StoredPhoto meta={p} />
                </div>
              ))}
            </div>
          </>
        )}

        <h3 className="section-title">History</h3>
        <ol className="timeline">
          {entry.history.map((h, i) => (
            <li key={i}>
              <b>{h.action}</b> by {ROLE_LABELS[h.role]} <span className="muted small">· {fmtDateTime(h.at)}</span>
              {h.note && <div className="small">{h.note}</div>}
            </li>
          ))}
        </ol>

        {canReview && (
          <label className="review-remarks">
            Review remarks <span className="muted small">(required when returning)</span>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={500} />
          </label>
        )}
        <ErrorList errors={errors} title="Action not completed" />
      </Modal>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete draft?"
          message={<p>Delete draft {entry.id}? This cannot be undone.</p>}
          confirmLabel="Delete draft"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void run(`${entry.id} deleted.`, () => repo.deleteDraftEntry(entry.id, role));
          }}
        />
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">{children}</div>
    </div>
  );
}

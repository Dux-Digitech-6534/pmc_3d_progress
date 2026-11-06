import { useState } from 'react';
import { errorMessages } from '../data/repository';
import { formatQty } from '../domain/progress';
import { UNIT_LABELS, type ProgressEntry } from '../domain/types';
import { useApp } from '../state/AppContext';
import { fmtDate, Modal } from './ui';

/** PMC Reviewer: send several submitted entries back to the site engineer with one reason. */
export function ReturnEntriesButton({ entries, onDone, label }: { entries: ProgressEntry[]; onDone?: () => void; label?: string }) {
  const { role, repo, notify, refresh } = useApp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!entries.length) return null;

  async function returnAll() {
    if (!reason.trim()) {
      setError('Enter a reason so the site engineer knows what to correct.');
      return;
    }
    setBusy(true);
    setError('');
    const failed: string[] = [];
    let ok = 0;
    for (const e of entries) {
      try {
        await repo.reviewProgressEntry(e.id, 'return', reason, role);
        ok++;
      } catch (err) {
        failed.push(`${e.elementCode} ${e.id}: ${errorMessages(err).join(' ')}`);
      }
    }
    setBusy(false);
    setOpen(false);
    setReason('');
    onDone?.();
    await refresh();
    if (ok) notify(`${ok} entr${ok === 1 ? 'y' : 'ies'} returned to the site engineer.`);
    if (failed.length) notify(`Not returned: ${failed.join(' | ')}`, 'error');
  }

  return (
    <>
      <button className="btn btn-small btn-warn" disabled={busy} onClick={() => setOpen(true)}>
        {label ?? `Return (${entries.length})`}
      </button>
      {open && (
        <Modal
          title={`Return ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} to the site engineer?`}
          onClose={() => !busy && setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-warn" onClick={() => void returnAll()} disabled={busy}>
                {busy ? 'Working…' : 'Return'}
              </button>
            </>
          }
        >
          <ul className="approve-list">
            {entries.map((e) => (
              <li key={e.id}>
                <b>{e.elementCode}</b> · {e.activityName} {formatQty(e.quantity, UNIT_LABELS[e.unit])} · {fmtDate(e.date)}
                {e.remarks ? ` — ${e.remarks}` : ''}
              </li>
            ))}
          </ul>
          <label className="review-remarks">
            Reason <span className="muted small">(required — the site engineer sees it)</span>
            <textarea value={reason} rows={2} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <p className="field-error">{error}</p>}
        </Modal>
      )}
    </>
  );
}

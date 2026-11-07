import { useState } from 'react';
import { errorMessages } from '../data/repository';
import { formatQty } from '../domain/progress';
import { UNIT_LABELS, type ElementRecord, type ProgressEntry } from '../domain/types';
import { permissions } from '../domain/workflow';
import { useApp } from '../state/AppContext';
import { ConfirmDialog, fmtDate } from './ui';

/** Site engineer: the drafts on the selected elements — send them all for approval, or delete them, in one go. */
export function DraftEntries({ elements, entries }: { elements: ElementRecord[]; entries: ProgressEntry[] }) {
  const { role, repo, notify, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<'submit' | 'delete' | null>(null);
  const ids = new Set(elements.map((e) => e.id));
  const drafts = entries
    .filter((e) => ids.has(e.elementId) && e.status === 'Draft' && permissions.canSubmit(role, e))
    .sort((a, b) => a.elementCode.localeCompare(b.elementCode) || a.createdAt.localeCompare(b.createdAt));
  if (!drafts.length) return null;

  async function run(what: 'submit' | 'delete') {
    setBusy(true);
    const failed: string[] = [];
    let ok = 0;
    for (const e of drafts) {
      try {
        if (what === 'submit') await repo.submitProgressEntry(e.id, role);
        else await repo.deleteDraftEntry(e.id, role);
        ok++;
      } catch (err) {
        failed.push(`${e.elementCode} ${e.activityName}: ${errorMessages(err).join(' ')}`);
      }
    }
    setBusy(false);
    setAsk(null);
    await refresh();
    if (ok) notify(what === 'submit' ? `${ok} draft${ok === 1 ? '' : 's'} sent for PMC approval.` : `${ok} draft${ok === 1 ? '' : 's'} deleted.`);
    if (failed.length) notify(`Not ${what === 'submit' ? 'sent' : 'deleted'}: ${failed.join(' | ')}`, 'error');
  }

  const acts = [...new Set(drafts.map((d) => d.activityName))];
  return (
    <div className="panel-section drafts-bar">
      <div className="history-head">
        <span>
          <b>{drafts.length}</b> draft{drafts.length === 1 ? '' : 's'} not sent yet <span className="muted small">({acts.join(', ')})</span>
        </span>
        <span className="history-btns">
          <button className="btn btn-small btn-danger-outline" disabled={busy} onClick={() => setAsk('delete')}>
            Delete
          </button>
          <button className="btn btn-small btn-primary" disabled={busy} onClick={() => setAsk('submit')}>
            Send for approval ({drafts.length})
          </button>
        </span>
      </div>
      {ask && (
        <ConfirmDialog
          title={ask === 'submit' ? `Send ${drafts.length} draft${drafts.length === 1 ? '' : 's'} for PMC approval?` : `Delete ${drafts.length} draft${drafts.length === 1 ? '' : 's'}?`}
          message={
            <>
              <ul className="approve-list">
                {drafts.map((e) => (
                  <li key={e.id}>
                    <b>{e.elementCode}</b> · {e.activityName} {formatQty(e.quantity, UNIT_LABELS[e.unit])} · {fmtDate(e.date)}
                    {e.remarks ? ` — ${e.remarks}` : ''}
                  </li>
                ))}
              </ul>
              {ask === 'delete' && <p className="muted small">Deleted drafts cannot be brought back.</p>}
            </>
          }
          confirmLabel={ask === 'submit' ? 'Send for approval' : 'Delete drafts'}
          danger={ask === 'delete'}
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={() => void run(ask)}
        />
      )}
    </div>
  );
}

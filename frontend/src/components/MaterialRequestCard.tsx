import { useEffect, useMemo, useState } from 'react';
import { IS_FRAPPE } from '../config';
import { errorMessages, type ErpItem } from '../data/repository';
import { inItemUnit, requestNeeds, suggestItem } from '../domain/materialRequest';
import type { MaterialRequired } from '../domain/materialRequired';
import { formatQty } from '../domain/progress';
import { useApp } from '../state/AppContext';
import { ErrorList } from './ui';

// For now every request goes to this company's Stores warehouse (not shown on the form).
const DEFAULT_COMPANY = 'Dux Digitech';
const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/**
 * Material Request for the material the selected elements need: the materials come from the
 * elements, the engineer sets each quantity, saves it as a draft and then submits it for approval.
 */
export function MaterialRequestCard({ req, elementIds, bagKg }: { req: MaterialRequired; elementIds: string; bagKg: number }) {
  const { repo, role, notify } = useApp();
  const [items, setItems] = useState<ErpItem[] | null>(null);
  const [company, setCompany] = useState('');
  const [warehouse, setWarehouse] = useState<string | undefined>();
  const [requiredBy, setRequiredBy] = useState(() => inDays(3));
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<{ name: string; state: string; submitted: boolean } | null>(null);

  useEffect(() => {
    Promise.all([repo.listErpItems(), repo.listErpCompanies()]).then(
      ([i, c]) => {
        setItems(i);
        setCompany(c.includes(DEFAULT_COMPANY) ? DEFAULT_COMPANY : (c[0] ?? ''));
      },
      (e) => {
        setItems([]);
        setErrors(errorMessages(e));
      },
    );
  }, [repo]);
  useEffect(() => {
    if (!company) return;
    repo.listErpWarehouses(company).then(
      (w) => setWarehouse(w.find((n) => /^stores\b/i.test(n))),
      () => setWarehouse(undefined),
    );
  }, [repo, company]);
  // a new selection is a new request
  useEffect(() => {
    setSaved(null);
    setTyped({});
    setErrors([]);
  }, [elementIds]);

  const needs = useMemo(() => requestNeeds(req), [req]);
  const lines = useMemo(
    () =>
      needs.map((n) => {
        const item = suggestItem(n, items ?? [], bagKg);
        const suggested = item ? inItemUnit(n, item.uom, bagKg) : null;
        const text = typed[n.key] ?? (suggested !== null ? String(suggested) : '');
        return { need: n, item, text, qty: Number(text) };
      }),
    [needs, typed, items, bagKg],
  );
  const ready = lines.filter((l) => l.item && l.text.trim() !== '' && Number.isFinite(l.qty) && l.qty > 0);
  const badQty = lines.some((l) => l.item && l.text.trim() !== '' && !(Number.isFinite(l.qty) && l.qty >= 0));

  if (!needs.length || role === 'owner') return null;

  async function run(what: 'draft' | 'submit') {
    if (busy) return;
    setBusy(true);
    setErrors([]);
    try {
      if (what === 'draft') {
        const out = await repo.createMaterialRequest({
          company,
          warehouse,
          requiredBy,
          lines: ready.map((l) => ({ itemCode: l.item!.code, qty: l.qty, uom: l.item!.uom })),
        });
        setSaved({ ...out, submitted: false });
        notify(`Material Request ${out.name} saved as draft — ${ready.length} item${ready.length === 1 ? '' : 's'}.`);
      } else if (saved) {
        const out = await repo.submitMaterialRequest(saved.name);
        setSaved({ ...out, submitted: true });
        notify(`Material Request ${out.name} submitted (${out.state}).`);
      }
    } catch (e) {
      setErrors(errorMessages(e));
    } finally {
      setBusy(false);
    }
  }

  const locked = !!saved;
  return (
    <div className="panel-section mr-card">
      <h3 className="section-title">Material Request</h3>
      {items === null ? (
        <p className="muted small">Reading items…</p>
      ) : (
        <>
          <div className="mr-fields">
            <label>
              Required by
              <input type="date" value={requiredBy} min={inDays(0)} disabled={locked} onChange={(e) => setRequiredBy(e.target.value)} />
            </label>
          </div>
          <table className="table compact mr-lines">
            <thead>
              <tr>
                <th>Material</th>
                <th className="num">Required</th>
                <th className="num">Request qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ need, item, text }) => (
                <tr key={need.key}>
                  <td>{need.label}</td>
                  <td className="num">{formatQty(need.qty, need.unit)}</td>
                  <td className="num">
                    {item ? (
                      <span className="mr-qty">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          inputMode="decimal"
                          value={text}
                          disabled={locked}
                          aria-label={`Request quantity of ${need.label} in ${item.uom}`}
                          onChange={(e) => setTyped((t) => ({ ...t, [need.key]: e.target.value }))}
                        />
                        <span className="muted small">{item.uom}</span>
                      </span>
                    ) : (
                      <span className="muted small">No item in ERPNext</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {badQty && <div className="warn-text small">Enter a quantity of 0 or more.</div>}
          <ErrorList errors={errors} title={saved ? 'Material Request not submitted' : 'Material Request not saved'} />
          {saved && (
            <div className={`alert ${saved.submitted ? 'alert-success' : 'alert-info'} small`}>
              <b>{saved.name}</b> {saved.submitted ? `submitted — ${saved.state}.` : 'saved as draft. Check it and press Submit.'}{' '}
              {IS_FRAPPE && (
                <a href={`/app/material-request/${encodeURIComponent(saved.name)}`} target="_blank" rel="noreferrer">
                  Open
                </a>
              )}
            </div>
          )}
          {!saved?.submitted && (
            <div className="form-actions">
              {!saved ? (
                <button className="btn btn-primary" disabled={busy || !ready.length || badQty || !company} onClick={() => void run('draft')}>
                  {busy ? 'Saving…' : `Save Draft (${ready.length} item${ready.length === 1 ? '' : 's'})`}
                </button>
              ) : (
                <button className="btn btn-primary" disabled={busy} onClick={() => void run('submit')}>
                  {busy ? 'Submitting…' : 'Submit'}
                </button>
              )}
            </div>
          )}
          <p className="hint">
            Materials and quantities come from the selected elements; change a quantity if needed. Materials with 0 or no item are left out.
          </p>
        </>
      )}
    </div>
  );
}

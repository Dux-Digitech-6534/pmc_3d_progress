import { useEffect, useMemo, useState } from 'react';
import { IS_FRAPPE } from '../config';
import { errorMessages, type ErpItem, type ErpProject } from '../data/repository';
import { inItemUnit, requestNeeds, suggestItem } from '../domain/materialRequest';
import { formatQty } from '../domain/progress';
import type { MaterialRequired } from '../domain/materialRequired';
import { useApp } from '../state/AppContext';
import { ErrorList } from './ui';

// For now every request goes to this company's Stores warehouse (not shown on the form).
const DEFAULT_COMPANY = 'Dux Digitech';
const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/**
 * Material Request for the material the selected elements need: the materials come from the
 * elements, the engineer types each quantity, saves it as a draft and then submits it for approval.
 */
export function MaterialRequestCard({ req, elementIds, bagKg }: { req: MaterialRequired; elementIds: string; bagKg: number }) {
  const { repo, role, notify, data } = useApp();
  const projectId = data?.project.id ?? '';
  const [items, setItems] = useState<ErpItem[] | null>(null);
  // ERPNext project of this PMC project (the one Material Variation uses): it goes on every line, so the
  // Purchase Order and Purchase Receipt made from the request carry it and the receipt counts as sent to the site
  const [erpProject, setErpProject] = useState<string | null>(null);
  const [erpProjects, setErpProjects] = useState<ErpProject[] | null>(null);
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
    if (!projectId) return;
    let alive = true;
    repo.getVariationSettings(projectId).then(
      (s) => alive && setErpProject(s.erpProject),
      () => alive && setErpProject(''),
    );
    return () => {
      alive = false;
    };
  }, [repo, projectId]);
  useEffect(() => {
    if (erpProject !== '' || erpProjects) return;
    repo.listErpProjects().then(setErpProjects, () => setErpProjects([]));
  }, [repo, erpProject, erpProjects]);
  const projectName = erpProjects?.find((p) => p.id === erpProject)?.name;
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
        const text = typed[n.key] ?? '';
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
          project: erpProject || undefined,
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
            {erpProject === '' ? (
              <label>
                Project
                <select
                  value=""
                  disabled={locked}
                  onChange={(e) => {
                    const v = e.target.value;
                    setErpProject(v);
                    repo.saveVariationSettings(projectId, { erpProject: v }).catch((err) => setErrors(errorMessages(err)));
                  }}
                >
                  <option value="">{erpProjects === null ? 'Loading…' : 'Choose the ERPNext project…'}</option>
                  {(erpProjects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id})
                    </option>
                  ))}
                </select>
              </label>
            ) : erpProject ? (
              <div className="small muted mr-project">
                Project: <b>{projectName ?? erpProject}</b>
              </div>
            ) : null}
            <label>
              Required by
              <input type="date" value={requiredBy} min={inDays(0)} disabled={locked} onChange={(e) => setRequiredBy(e.target.value)} />
            </label>
          </div>
          <table className="table compact mr-lines">
            <thead>
              <tr>
                <th>Material</th>
                <th className="num">Qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ need, item, text }) => (
                <tr key={need.key}>
                  <td>
                    {need.label}
                    {(() => {
                      // what the selection needs, also in the ERP item's own unit (m³ → Cft, kg → MT …)
                      const inUnit = item ? inItemUnit(need, item.uom, bagKg) : null;
                      const same = item && inUnit !== null && item.uom.trim().toLowerCase().replace(/[\s.³]/g, '') === need.unit.toLowerCase().replace(/[\s.³]/g, '');
                      return (
                        <div className="muted small mr-need">
                          Need {formatQty(need.qty, need.unit)}
                          {item && inUnit !== null && !same && <> = {formatQty(inUnit, item.uom)}</>}
                          {item && inUnit !== null && !locked && (
                            <button type="button" className="link" onClick={() => setTyped((t) => ({ ...t, [need.key]: String(inUnit) }))}>
                              Use
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </td>
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
                          placeholder="0"
                          aria-label={`Quantity of ${need.label} in ${item.uom}`}
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
                <button className="btn btn-primary" disabled={busy || !ready.length || badQty || !company || !erpProject} onClick={() => void run('draft')}>
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
            Materials come from the selected elements; enter the quantity to request. Materials left blank are not requested.{erpProject === '' ? ' Choose the project first — the order and the receipt then carry it, so the material shows as sent to this site.' : ''}
          </p>
        </>
      )}
    </div>
  );
}

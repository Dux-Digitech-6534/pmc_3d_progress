import { useEffect, useMemo, useState } from 'react';
import { IS_FRAPPE } from '../config';
import { errorMessages, type ErpItem, type ErpProject } from '../data/repository';
import { inItemUnit, requestNeeds, suggestItem } from '../domain/materialRequest';
import type { MaterialRequired } from '../domain/materialRequired';
import { formatQty } from '../domain/progress';
import { useApp } from '../state/AppContext';
import { ErrorList } from './ui';

// Choices remembered in this browser only (per-viewer conveniences).
const load = (k: string) => {
  try {
    return localStorage.getItem(`pmc3d.${k}`) ?? '';
  } catch {
    return '';
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(`pmc3d.${k}`, v);
  } catch {
    /* not remembered when the browser blocks storage */
  }
};
const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/**
 * ERPNext Material Request for the material the selected elements need: one click creates it, with
 * each material on its ERP item (matched by name, changeable) and the project on every line.
 */
export function MaterialRequestCard({ req, elementIds, bagKg }: { req: MaterialRequired; elementIds: string; bagKg: number }) {
  const { repo, data, role, notify } = useApp();
  const projectId = data?.project.id ?? '';
  const [items, setItems] = useState<ErpItem[] | null>(null);
  const [companies, setCompanies] = useState<string[]>([]);
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [erpProjects, setErpProjects] = useState<ErpProject[]>([]);
  const [company, setCompany] = useState(() => load('erpCompany'));
  const [warehouse, setWarehouse] = useState(() => load('erpWarehouse'));
  const [project, setProject] = useState(() => load(`erpProject.${projectId}`));
  const [requiredBy, setRequiredBy] = useState(() => inDays(3));
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [created, setCreated] = useState<{ name: string; state: string } | null>(null);

  useEffect(() => {
    Promise.all([repo.listErpItems(), repo.listErpCompanies(), repo.listErpProjects()]).then(
      ([i, c, p]) => {
        setItems(i);
        setCompanies(c);
        setErpProjects(p);
        setCompany((v) => (c.includes(v) ? v : (c[0] ?? '')));
      },
      (e) => {
        setItems([]);
        setErrors(errorMessages(e));
      },
    );
  }, [repo]);
  useEffect(() => {
    if (!company) return setWarehouses([]);
    repo.listErpWarehouses(company).then(setWarehouses, () => setWarehouses([]));
  }, [repo, company]);
  // a new selection is a new request
  useEffect(() => {
    setCreated(null);
    setErrors([]);
  }, [elementIds]);

  const needs = useMemo(() => requestNeeds(req), [req]);
  const lines = useMemo(
    () =>
      needs.map((n) => {
        const code = chosen[n.key] ?? (load(`erpItem.${n.key}`) || suggestItem(n, items ?? [], bagKg)?.code || '');
        const item = items?.find((i) => i.code === code);
        const qty = item ? inItemUnit(n, item.uom, bagKg) : null;
        return { need: n, item, qty };
      }),
    [needs, chosen, items, bagKg],
  );
  const ready = lines.filter((l) => l.item && l.qty && l.qty > 0);

  if (!needs.length || role === 'owner') return null;

  async function create() {
    if (busy || !ready.length || !company) return;
    setBusy(true);
    setErrors([]);
    try {
      const out = await repo.createMaterialRequest({
        company,
        project: project || undefined,
        warehouse: warehouse && warehouses.includes(warehouse) ? warehouse : undefined,
        requiredBy,
        lines: ready.map((l) => ({ itemCode: l.item!.code, qty: l.qty!, uom: l.item!.uom })),
      });
      setCreated(out);
      notify(`Material Request ${out.name} created in ERPNext (${out.state}) — ${ready.length} item${ready.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setErrors(errorMessages(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-section mr-card">
      <h3 className="section-title">Material Request (ERPNext)</h3>
      {items === null ? (
        <p className="muted small">Reading ERPNext items…</p>
      ) : (
        <>
          <div className="mr-fields">
            <label>
              Company
              <select
                value={company}
                onChange={(e) => {
                  setCompany(e.target.value);
                  save('erpCompany', e.target.value);
                }}
              >
                {!companies.length && <option value="">—</option>}
                {companies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  save(`erpProject.${projectId}`, e.target.value);
                }}
              >
                <option value="">No project</option>
                {erpProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Warehouse
              <select
                value={warehouses.includes(warehouse) ? warehouse : ''}
                onChange={(e) => {
                  setWarehouse(e.target.value);
                  save('erpWarehouse', e.target.value);
                }}
              >
                <option value="">Not set</option>
                {warehouses.map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </label>
            <label>
              Required by
              <input type="date" value={requiredBy} min={inDays(0)} onChange={(e) => setRequiredBy(e.target.value)} />
            </label>
          </div>
          <table className="table compact mr-lines">
            <thead>
              <tr>
                <th>Material</th>
                <th>ERPNext item</th>
                <th className="num">Qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ need, item, qty }) => (
                <tr key={need.key}>
                  <td>
                    {need.label}
                    <div className="muted small">{formatQty(need.qty, need.unit)}</div>
                  </td>
                  <td>
                    <select
                      value={item?.code ?? ''}
                      aria-label={`ERPNext item for ${need.label}`}
                      onChange={(e) => {
                        setChosen((c) => ({ ...c, [need.key]: e.target.value }));
                        save(`erpItem.${need.key}`, e.target.value);
                      }}
                    >
                      <option value="">Not requested</option>
                      {(items ?? []).map((i) => (
                        <option key={i.code} value={i.code}>
                          {i.name} ({i.uom})
                        </option>
                      ))}
                    </select>
                    {item && qty === null && <div className="warn-text small">{item.uom} cannot be converted from {need.unit} — pick an item in another unit.</div>}
                  </td>
                  <td className="num">{item && qty !== null ? formatQty(qty, item.uom) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ErrorList errors={errors} title="Material Request not created" />
          {created ? (
            <div className="alert alert-success small">
              <b>{created.name}</b> created in ERPNext — {created.state}.{' '}
              {IS_FRAPPE && (
                <a href={`/app/material-request/${encodeURIComponent(created.name)}`} target="_blank" rel="noreferrer">
                  Open in ERPNext
                </a>
              )}
            </div>
          ) : (
            <div className="form-actions">
              <button className="btn btn-primary" disabled={busy || !ready.length || !company} onClick={() => void create()}>
                {busy ? 'Creating…' : `Create Material Request (${ready.length} item${ready.length === 1 ? '' : 's'})`}
              </button>
            </div>
          )}
          <p className="hint">
            Items are matched by name (TMT 12 mm, OPC cement, river sand, 20 mm metal, bricks); change any line, or pick "Not requested" to leave it out. The
            request then goes through the ERPNext approval.
          </p>
        </>
      )}
    </div>
  );
}

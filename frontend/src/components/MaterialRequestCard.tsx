import { useEffect, useMemo, useState } from 'react';
import type { ConcreteMode } from '../domain/concrete';
import { WhatsAppIcon } from './MaterialRequiredPanel';
import { IS_FRAPPE } from '../config';
import { errorMessages, type ErpItem, type MaterialRequestSummary } from '../data/repository';
import { inItemUnit, requestNeeds, suggestItem } from '../domain/materialRequest';
import { toReportUnit } from '../domain/materialVariation';
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
export function MaterialRequestCard({
  req,
  elementIds,
  bagKg,
  onDownload,
  onShare,
  sharing,
  mode = 'rmc',
}: {
  /** The project's concrete: ready-mix (grade + m³) or site mix (cement, sand, gitti). */
  mode?: ConcreteMode;
  req: MaterialRequired;
  elementIds: string;
  bagKg: number;
  /** Requirement Excel of the selection; with the request number once the request is saved. */
  onDownload?: (mrName?: string) => void;
  /** The same requirement as a picture, shared on WhatsApp. */
  onShare?: (mrName?: string) => void;
  sharing?: boolean;
}) {
  const { repo, role, notify, data } = useApp();
  const projectId = data?.project.id ?? '';
  const [items, setItems] = useState<ErpItem[] | null>(null);
  // Not asked on the form: the ERPNext project of the project chosen at the top (linked, found or created on
  // the server) goes on every line, so the order and receipt carry it and Material Variation counts it.
  const [erpProject, setErpProject] = useState<string | null>(null);
  const [company, setCompany] = useState('');
  const [warehouse, setWarehouse] = useState<string | undefined>();
  const [requiredBy, setRequiredBy] = useState(() => inDays(3));
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<{ name: string; state: string; submitted: boolean } | null>(null);
  // requests already made for this project (so nobody asks twice without seeing it)
  const [earlier, setEarlier] = useState<MaterialRequestSummary[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  // The ERPNext project can be shared with an older PMC project (e.g. one deleted and made again), so only
  // requests made since this PMC project was created are shown as "already requested".
  const since = (data?.project.createdAt ?? '').slice(0, 10);
  const loadEarlier = (p: string) =>
    repo.listMaterialRequests(p).then(
      (l) => setEarlier(since ? l.filter((m) => !m.date || m.date >= since) : l),
      () => setEarlier([]),
    );

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
    repo.ensureErpProject(projectId).then(
      (s) => {
        if (!alive) return;
        setErpProject(s.erpProject);
        void loadEarlier(s.erpProject);
      },
      () => alive && setErpProject(''),
    );
    return () => {
      alive = false;
    };
  }, [repo, projectId]);
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

  const needs = useMemo(() => requestNeeds(req, mode), [req, mode]);
  const lines = useMemo(
    () =>
      needs.map((n) => {
        const item = suggestItem(n, items ?? [], bagKg);
        // cement is asked in bags even when the ERP item is kept in kg (meeting 16-11)
        const perUom = item ? toReportUnit(n.kind, 1, item.uom, bagKg) : null;
        const bags = !!item && n.kind === 'cement' && !!perUom && !/bag/i.test(item.uom);
        // the quantity is filled in from the requirement; the user can change it
        const auto = item ? (bags ? Math.ceil(n.qty - 1e-9) : inItemUnit(n, item.uom, bagKg)) : null;
        const text = typed[n.key] ?? (auto !== null ? String(auto) : '');
        const entered = Number(text);
        const qty = bags && perUom ? Math.round((entered / perUom) * 100) / 100 : entered;
        return { need: n, item, text, qty, bags, entered };
      }),
    [needs, typed, items, bagKg],
  );
  const ready = lines.filter((l) => l.item && l.text.trim() !== '' && Number.isFinite(l.qty) && l.qty > 0);
  const badQty = lines.some((l) => l.item && l.text.trim() !== '' && !(Number.isFinite(l.entered) && l.entered >= 0));

  // requests already made for this project: shown even when the selection needs nothing new (or for the Owner)
  const earlierBlock =
    earlier && earlier.length > 0 ? (
          <div className="mr-earlier">
            <h4>
              Already requested for this project <span className="muted">({earlier.length})</span>
            </h4>
            {(showAll ? earlier : earlier.slice(0, 5)).map((m) => (
              <div key={m.name} className="mr-earlier-row">
                <div>
                  {IS_FRAPPE ? (
                    <a href={`/app/material-request/${encodeURIComponent(m.name)}`} target="_blank" rel="noreferrer">
                      <b>{m.name}</b>
                    </a>
                  ) : (
                    <b>{m.name}</b>
                  )}
                  <span className="muted small"> · {new Date(`${m.date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                  <div className="muted small">{m.items.map((i) => `${i.name} ${formatQty(i.qty)} ${i.uom}`).join(' · ')}</div>
                </div>
                <span className={`mr-state ${/reject|cancel/i.test(m.state) ? 'bad' : /approved|ordered|received|transferred|issued|completed/i.test(m.state) ? 'good' : ''}`}>{m.state}</span>
              </div>
            ))}
            {earlier.length > 5 && (
              <button className="link" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show fewer' : `Show all ${earlier.length}`}
              </button>
            )}
          </div>
    ) : null;
  if (!needs.length || role === 'owner') return earlierBlock ? <div className="panel-section mr-card">{earlierBlock}</div> : null;

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
        if (erpProject) void loadEarlier(erpProject);
        notify(`Material Request ${out.name} saved as draft — ${ready.length} item${ready.length === 1 ? '' : 's'}.`);
      } else if (saved) {
        const out = await repo.submitMaterialRequest(saved.name);
        setSaved({ ...out, submitted: true });
        if (erpProject) void loadEarlier(erpProject);
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
      <div className="mr-head">
        <h3 className="section-title">Material Request</h3>
        {onDownload && !saved && (
          <div className="mr-share-actions">
            <button className="btn btn-small" onClick={() => onDownload()}>
              Download requirement (Excel)
            </button>
            {onShare && (
              <button className="btn btn-small btn-wa" onClick={() => onShare()} disabled={sharing}>
                <WhatsAppIcon /> {sharing ? 'Preparing…' : 'Share on WhatsApp'}
              </button>
            )}
          </div>
        )}
      </div>
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
                <th className="num">Qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ need, item, text, bags, qty }) => (
                <tr key={need.key}>
                  <td>
                    {need.label}
                    {(() => {
                      // what the selection needs, also in the ERP item's own unit (m³ → Cft, kg → MT …)
                      const inUnit = item ? inItemUnit(need, item.uom, bagKg) : null;
                      // "m³ = Cubic Meter" is the same unit: show the second figure only when it is really another unit
                      const same = item && toReportUnit(need.kind, 1, item.uom, bagKg) === 1;
                      return (
                        <div className="muted small mr-need">
                          Need {formatQty(need.qty, need.unit)}
                          {item && inUnit !== null && !same && !bags && <> = {formatQty(inUnit, item.uom)}</>}
                          {bags && item && Number.isFinite(qty) && qty > 0 && <> · goes to ERPNext as {formatQty(qty, item.uom)}</>}
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
                          aria-label={`Quantity of ${need.label} in ${bags ? 'bags' : item.uom}`}
                          onChange={(e) => setTyped((t) => ({ ...t, [need.key]: e.target.value }))}
                        />
                        <span className="muted small">{bags ? 'bags' : item.uom}</span>
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
              {onDownload && (
                <div className="mr-saved-actions">
                  <button className="btn btn-small" onClick={() => onDownload(saved.name)}>
                    Download requirement (Excel)
                  </button>
                  {onShare && (
                    <button className="btn btn-small btn-wa" onClick={() => onShare(saved.name)} disabled={sharing}>
                      <WhatsAppIcon /> {sharing ? 'Preparing…' : 'Share on WhatsApp'}
                    </button>
                  )}
                </div>
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
            Quantities are filled in from what the selected elements need — change any of them if needed. A line left blank or 0 is not requested.
          </p>
        </>
      )}
      {earlierBlock}
    </div>
  );
}

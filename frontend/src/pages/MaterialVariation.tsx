import { useEffect, useMemo, useState } from 'react';
import { EmptyState, ErrorList, PageHeader, Spinner } from '../components/ui';
import { IS_FRAPPE } from '../config';
import { errorMessages, type ErpProject } from '../data/repository';
import { materialRequired } from '../domain/materialRequired';
import { normsOf } from '../domain/materials';
import { variationReport, type SentLine, type VariationStatus } from '../domain/materialVariation';
import { formatQty } from '../domain/progress';
import { useApp } from '../state/AppContext';

/** Variation still counted as OK: 2–4 % over is normal on site (laps, wastage), per the PMC. */
const TOLERANCE_PCT = 5;

const STATUS_TEXT: Record<VariationStatus, string> = {
  ok: 'OK',
  excess: 'More sent',
  short: 'Less sent',
  'no-work': 'Sent, no work yet',
  'not-sent': 'Not sent',
};

/** The ERP project picked for a PMC project, remembered in this browser only. */
const erpKey = (projectId: string) => `pmc3d.erpProject.${projectId}`;
const remembered = (projectId: string) => {
  try {
    return localStorage.getItem(erpKey(projectId)) ?? '';
  } catch {
    return '';
  }
};

/**
 * Material variation: what the ERP sent to the site against what the approved work done should
 * have used ("300 kg should have gone in — 500 kg was asked for"). A few % over is normal on site.
 */
export function MaterialVariation() {
  const { data, repo, go } = useApp();
  const projectId = data?.project.id ?? '';
  const [erpProjects, setErpProjects] = useState<ErpProject[] | null>(null);
  const [erpProject, setErpProject] = useState(() => remembered(projectId));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<SentLine[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => setErpProject(remembered(projectId)), [projectId]);
  useEffect(() => {
    repo.listErpProjects().then(setErpProjects, (e) => {
      setErpProjects([]);
      setErrors(errorMessages(e));
    });
  }, [repo]);
  useEffect(() => {
    if (!erpProject) return setLines(null);
    let alive = true;
    setLoading(true);
    setErrors([]);
    repo
      .listMaterialSent(erpProject, from || undefined, to || undefined)
      .then(
        (l) => alive && setLines(l),
        (e) => alive && (setLines(null), setErrors(errorMessages(e))),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repo, erpProject, from, to]);

  const norms = normsOf(data?.model?.document);
  const tol = TOLERANCE_PCT;
  // what the approved work done (in the dates) should have used
  const needed = useMemo(() => {
    const approved = (data?.entries ?? []).filter((e) => e.status === 'Approved' && (!from || e.date >= from) && (!to || e.date <= to));
    return materialRequired(data?.elements ?? [], approved, norms, 'done');
  }, [data?.elements, data?.entries, norms, from, to]);
  const report = useMemo(() => (lines ? variationReport(lines, needed, norms, tol) : null), [lines, needed, norms, tol]);

  if (!data) return <Spinner label="Loading project…" />;
  if (!data.model) {
    return (
      <EmptyState
        title={`No 3D + BOQ for ${data.project.name} yet`}
        action={
          <button className="btn btn-primary" onClick={() => go('models')}>
            Upload 3D + BOQ
          </button>
        }
      >
        The variation report compares the material sent with what the approved work done should have used — it needs the project's 3D + BOQ.
      </EmptyState>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Material variation"
        subtitle="Material sent to the site (ERPNext) against what the approved work done should have used. A few % more is normal on site — laps and wastage; a big difference needs a question to the site."
      />
      <section className="card">
        <div className="variation-filters">
          <label>
            Project
            <select
              value={erpProject}
              onChange={(e) => {
                setErpProject(e.target.value);
                try {
                  localStorage.setItem(erpKey(projectId), e.target.value);
                } catch {
                  /* remembered only when the browser allows it */
                }
              }}
            >
              <option value="">{erpProjects === null ? 'Loading…' : 'Choose…'}</option>
              {(erpProjects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
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
          <label>
            OK within ±
            <span className="inline">
              <input type="text" value={TOLERANCE_PCT} readOnly aria-readonly="true" title="Fixed: a few % over is normal on site (laps, wastage)" style={{ width: 70 }} /> %
            </span>
          </label>
        </div>
        <p className="hint">
          Sent = submitted {IS_FRAPPE ? 'ERPNext' : 'demo ERP'} Stock Entries (Material Issue / Material Transfer) and Purchase Receipts with this project. Should have used =
          approved work done{from || to ? ' in these dates' : ''} × the model's norms ({norms.concreteGrade}
          {norms.wastagePct ? `, ${norms.wastagePct}% wastage` : ''}), steel by bar size from the BBS or the typical bar mix.
        </p>
      </section>

      <ErrorList errors={errors} title="Could not read the ERP" />
      {!erpProject ? (
        <EmptyState title="Choose the project">Pick the ERPNext project whose material issues and receipts belong to {data.project.name}.</EmptyState>
      ) : loading || !report ? (
        <Spinner label="Reading ERPNext…" />
      ) : (
        <>
          <section className="card table-card">
            <h2 className="card-title">Sent vs should have used</h2>
            {report.rows.length === 0 ? (
              <p className="muted pad">No building material sent and no approved work yet.</p>
            ) : (
              <table className="table variation-table" data-testid="variation-table">
                <thead>
                  <tr>
                    <th>Material</th>
                    <th className="num">Sent</th>
                    <th className="num">Should have used</th>
                    <th className="num">Difference</th>
                    <th className="num">Variation</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.key} className={r.sub ? 'sub' : ''}>
                      <td>{r.label}</td>
                      <td className="num">{formatQty(r.sent, r.unit)}</td>
                      <td className="num">{formatQty(r.needed, r.unit)}</td>
                      <td className="num">
                        {r.difference > 0 ? '+' : ''}
                        {formatQty(r.difference, r.unit)}
                      </td>
                      <td className="num">{r.percent === null ? '—' : `${r.percent > 0 ? '+' : ''}${r.percent}%`}</td>
                      <td>
                        <span className={`var-badge var-${r.status}`}>{STATUS_TEXT[r.status]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          {(report.unmatched.length > 0 || report.unconvertible.length > 0) && (
            <section className="card">
              <h2 className="card-title">Not counted</h2>
              {report.unconvertible.length > 0 && (
                <>
                  <p className="small">The unit of these items cannot be turned into the report unit — keep them in that unit in ERPNext (e.g. sand in m³ or cft, not kg):</p>
                  <ul className="small">
                    {report.unconvertible.map((u) => (
                      <li key={u.itemCode}>
                        {u.itemName} — {formatQty(u.qty, u.uom)} (needs {u.unit})
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {report.unmatched.length > 0 && (
                <>
                  <p className="small">Not a building material this report knows (by the item name):</p>
                  <ul className="small muted">
                    {report.unmatched.map((u) => (
                      <li key={u.itemCode}>
                        {u.itemName} — {formatQty(u.qty, u.uom)}
                      </li>
                    ))}
                  </ul>
                  <p className="hint">Items are recognised by name: TMT / sariya with the size in mm, cement / OPC / PPC, sand, aggregate / gitti / 20 mm metal, RMC M25, bricks.</p>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

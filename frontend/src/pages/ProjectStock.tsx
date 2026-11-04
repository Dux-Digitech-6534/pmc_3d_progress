import { useEffect, useMemo, useState } from 'react';
import { EmptyState, ErrorList, PageHeader, Spinner } from '../components/ui';
import { IS_FRAPPE } from '../config';
import { errorMessages, type ErpItem, type ErpProject, type StockMove } from '../data/repository';
import { projectStock } from '../domain/projectStock';
import { formatQty } from '../domain/progress';
import { useApp } from '../state/AppContext';

/**
 * Project stock: how much of each item each ERPNext project has — received, issued / used and the
 * balance, per warehouse — from the stock ledger lines that carry the project.
 */
export function ProjectStock() {
  const { repo } = useApp();
  const [moves, setMoves] = useState<StockMove[] | null>(null);
  const [items, setItems] = useState<ErpItem[]>([]);
  const [projects, setProjects] = useState<ErpProject[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [project, setProject] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [asOn, setAsOn] = useState('');
  const [search, setSearch] = useState('');
  const [buildingOnly, setBuildingOnly] = useState(false);

  useEffect(() => {
    Promise.all([repo.listErpItems(), repo.listErpProjects()]).then(
      ([i, p]) => {
        setItems(i);
        setProjects(p);
      },
      (e) => setErrors(errorMessages(e)),
    );
  }, [repo]);
  useEffect(() => {
    let alive = true;
    setMoves(null);
    repo.listStockMoves(asOn || undefined).then(
      (m) => alive && setMoves(m),
      (e) => alive && (setMoves([]), setErrors(errorMessages(e))),
    );
    return () => {
      alive = false;
    };
  }, [repo, asOn]);

  const projectIds = useMemo(() => [...new Set((moves ?? []).map((m) => m.project))], [moves]);
  const warehouses = useMemo(
    () => [...new Set((moves ?? []).filter((m) => !project || m.project === project).map((m) => m.warehouse))].sort(),
    [moves, project],
  );
  const groups = useMemo(
    () => (moves ? projectStock(moves, items, projects, { project, warehouse, search, buildingOnly }) : []),
    [moves, items, projects, project, warehouse, search, buildingOnly],
  );
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="page">
      <PageHeader
        title="Project stock"
        subtitle="How much material each project has: received, issued or used, and the balance left — per warehouse, from the ERPNext stock ledger."
      />
      <section className="card">
        <div className="variation-filters">
          <label>
            Project
            <select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setWarehouse('');
              }}
            >
              <option value="">All projects</option>
              {projectIds
                .map((id) => [id, nameOf(id)] as const)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([id, name]) => (
                  <option key={id} value={id}>
                    {name} ({id})
                  </option>
                ))}
            </select>
          </label>
          <label>
            Warehouse
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
              <option value="">All warehouses</option>
              {warehouses.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </label>
          <label>
            As on
            <input type="date" value={asOn} onChange={(e) => setAsOn(e.target.value)} />
          </label>
          <label>
            Item
            <input type="search" value={search} placeholder="Search item…" onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>
        <label className="check small">
          <input type="checkbox" checked={buildingOnly} onChange={(e) => setBuildingOnly(e.target.checked)} /> Building materials only (steel, cement, sand, gitti,
          bricks, ready-mix)
        </label>
        <p className="hint">
          Counted: submitted {IS_FRAPPE ? 'ERPNext' : 'demo ERP'} stock movements that carry the project — receipts, transfers and issues. Stock moved without a
          project is not in this report.
        </p>
      </section>

      <ErrorList errors={errors} title="Could not read the ERP" />
      {moves === null ? (
        <Spinner label="Reading ERPNext stock…" />
      ) : groups.length === 0 ? (
        <EmptyState title="No stock found">
          {moves.length ? 'Nothing matches these filters.' : 'No stock movement in ERPNext carries a project yet. Receipts and issues made with a project show here.'}
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.project} className="card table-card" data-testid="project-stock">
            <h2 className="card-title">
              {g.projectName} <span className="muted small">({g.project})</span>
            </h2>
            <table className="table stock-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Warehouse</th>
                  <th className="num">Received</th>
                  <th className="num">Issued / used</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={`${r.warehouse}|${r.itemCode}`}>
                    <td>
                      {r.itemName}
                      <div className="muted small">
                        {r.itemCode}
                        {r.material ? ` · ${r.material}` : ''}
                      </div>
                    </td>
                    <td className="small">{r.warehouse}</td>
                    <td className="num">{formatQty(r.received, r.uom)}</td>
                    <td className="num">{formatQty(r.issued, r.uom)}</td>
                    <td className={`num ${r.balance < 0 ? 'neg' : ''}`}>
                      <b>{formatQty(r.balance, r.uom)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}

// Project-wise stock: the ERPNext stock ledger lines that carry a project, added up per project,
// warehouse and item — received (+), issued or used (−) and the balance left.

import type { ErpItem, ErpProject, StockMove } from '../data/repository';
import { matchItem } from './materialVariation';
import { roundQty } from './progress';

export interface ProjectStockRow {
  warehouse: string;
  itemCode: string;
  itemName: string;
  /** "Steel 12 mm", "Cement" … when the item is a building material, else null. */
  material: string | null;
  uom: string;
  received: number;
  issued: number;
  balance: number;
}

export interface ProjectStockGroup {
  project: string;
  projectName: string;
  rows: ProjectStockRow[];
}

const MATERIAL_LABELS: Record<string, string> = {
  steel: 'Steel',
  cement: 'Cement',
  sand: 'Sand',
  aggregate: 'Aggregate (gitti)',
  bricks: 'Bricks',
  concrete: 'Ready-mix concrete',
};

export function materialLabel(name: string, code: string): string | null {
  const m = matchItem(name, code);
  if (!m) return null;
  if (m.kind === 'steel') return m.dia ? `Steel ${m.dia} mm` : 'Steel';
  if (m.kind === 'concrete') return m.grade ? `Ready-mix ${m.grade}` : MATERIAL_LABELS.concrete;
  return MATERIAL_LABELS[m.kind];
}

export function projectStock(
  moves: StockMove[],
  items: ErpItem[],
  projects: ErpProject[],
  opts: { project?: string; warehouse?: string; search?: string; buildingOnly?: boolean } = {},
): ProjectStockGroup[] {
  const itemName = new Map(items.map((i) => [i.code, i.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const q = (opts.search ?? '').trim().toLowerCase();
  const groups = new Map<string, Map<string, ProjectStockRow>>();
  for (const m of moves) {
    if (opts.project && m.project !== opts.project) continue;
    if (opts.warehouse && m.warehouse !== opts.warehouse) continue;
    const name = itemName.get(m.itemCode) ?? m.itemCode;
    const material = materialLabel(name, m.itemCode);
    if (opts.buildingOnly && !material) continue;
    if (q && !`${name} ${m.itemCode} ${material ?? ''}`.toLowerCase().includes(q)) continue;
    const rows = groups.get(m.project) ?? groups.set(m.project, new Map()).get(m.project)!;
    const key = `${m.warehouse}|${m.itemCode}`;
    const r = rows.get(key) ?? { warehouse: m.warehouse, itemCode: m.itemCode, itemName: name, material, uom: m.uom, received: 0, issued: 0, balance: 0 };
    if (m.qty >= 0) r.received += m.qty;
    else r.issued -= m.qty;
    r.balance += m.qty;
    rows.set(key, r);
  }
  return [...groups]
    .map(([project, rows]) => ({
      project,
      projectName: projectName.get(project) ?? project,
      rows: [...rows.values()]
        .map((r) => ({ ...r, received: roundQty(r.received, 3), issued: roundQty(r.issued, 3), balance: roundQty(r.balance, 3) }))
        .sort((a, b) => a.warehouse.localeCompare(b.warehouse) || (a.material ?? '~').localeCompare(b.material ?? '~') || a.itemName.localeCompare(b.itemName)),
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

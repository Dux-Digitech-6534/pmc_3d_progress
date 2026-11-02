// Lines of an ERPNext Material Request from the material the selected elements need: steel per bar
// size, cement, sand, gitti, bricks — each on the ERP item that is that material, in its stock unit.

import type { MaterialRequired } from './materialRequired';
import { matchItem, toReportUnit, type MaterialKind } from './materialVariation';

export interface RequestNeed {
  /** "steel:12", "cement" … — also the key an ERP item choice is remembered by. */
  key: string;
  label: string;
  kind: MaterialKind;
  dia?: number;
  /** Quantity in the report unit (kg, bags, m³, nos). */
  qty: number;
  unit: string;
}

/** What to request for the needed material (site-mixed concrete: cement, sand and gitti; no ready-mix line). */
export function requestNeeds(req: MaterialRequired): RequestNeed[] {
  const out: RequestNeed[] = req.steel.map((s) => ({
    key: `steel:${s.dia}`,
    label: s.dia ? `Steel ${s.dia} mm` : 'Steel (size not set)',
    kind: 'steel' as const,
    dia: s.dia,
    qty: s.kg,
    unit: 'kg',
  }));
  const add = (kind: MaterialKind, label: string, qty: number, unit: string) => qty > 0 && out.push({ key: kind, label, kind, qty, unit });
  add('cement', 'Cement', req.materials.cement, 'bags');
  add('sand', 'Sand', req.materials.sand, 'm³');
  add('aggregate', 'Aggregate (gitti)', req.materials.aggregate, 'm³');
  add('bricks', 'Bricks', req.materials.bricks, 'nos');
  return out.filter((n) => n.qty > 0);
}

export interface ItemLike {
  code: string;
  name: string;
  uom: string;
}

/** The ERP item that is this material (same kind, same bar size for steel), or undefined. */
export function suggestItem(need: RequestNeed, items: ItemLike[], bagKg: number): ItemLike | undefined {
  return items.find((i) => {
    const m = matchItem(i.name, i.code);
    return m?.kind === need.kind && (need.kind !== 'steel' || m.dia === need.dia) && toReportUnit(need.kind, 1, i.uom, bagKg) !== null;
  });
}

/**
 * The quantity in the item's stock unit, rounded up so the request is never short (whole bags and
 * numbers, whole kg, 0.01 of other units); null when the unit cannot be converted.
 */
export function inItemUnit(need: RequestNeed, uom: string, bagKg: number): number | null {
  const per = toReportUnit(need.kind, 1, uom, bagKg);
  if (!per) return null;
  const q = need.qty / per;
  const u = uom.trim().toLowerCase();
  const whole = ['bag', 'bags', 'nos', 'no', 'pcs', 'piece', 'pieces', 'unit', 'units', 'kg', 'kgs'].includes(u);
  return whole ? Math.ceil(q - 1e-9) : Math.ceil(q * 100 - 1e-9) / 100;
}

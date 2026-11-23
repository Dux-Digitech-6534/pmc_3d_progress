// Lines of an ERPNext Material Request from the material the selected elements need: steel per bar
// size, concrete per grade (ready-mix, m³), and cement, sand, bricks for brickwork and plaster — each on
// the ERP item that is that material, in its stock unit.

import type { MaterialRequired } from './materialRequired';
import type { ConcreteMode } from './concrete';
import { matchItem, toReportUnit, type MaterialKind } from './materialVariation';

export interface RequestNeed {
  /** "steel:12", "cement" … — also the key an ERP item choice is remembered by. */
  key: string;
  label: string;
  kind: MaterialKind;
  dia?: number;
  /** Concrete grade ("M25"). */
  grade?: string;
  /** Quantity in the report unit (kg, bags, m³, nos). */
  qty: number;
  unit: string;
}

/**
 * What to request for the needed material. Concrete is asked as it is ordered — grade and m³, like an
 * RMC order (meeting 21-11) — not split into cement, sand and gitti; cement and sand are only for
 * brickwork and plaster.
 */
export function requestNeeds(req: MaterialRequired, mode: ConcreteMode = 'rmc'): RequestNeed[] {
  const out: RequestNeed[] = req.steel.map((s) => ({
    key: `steel:${s.dia}`,
    label: s.dia ? `Steel ${s.dia} mm` : 'Steel (size not set)',
    kind: 'steel' as const,
    dia: s.dia,
    qty: s.kg,
    unit: 'kg',
  }));
  // mixed on site: cement, sand and gitti for the concrete too, no ready-mix line
  if (mode === 'site') {
    const add = (kind: MaterialKind, label: string, qty: number, unit: string) => qty > 0 && out.push({ key: kind, label, kind, qty, unit });
    add('cement', 'Cement', req.materials.cement, 'bags');
    add('sand', 'Sand', req.materials.sand, 'm³');
    add('aggregate', 'Aggregate (gitti)', req.materials.aggregate, 'm³');
    add('bricks', 'Bricks', req.materials.bricks, 'nos');
    return out.filter((n) => n.qty > 0);
  }
  for (const c of req.concrete) {
    const grade = c.grade === 'Other' ? undefined : c.grade;
    out.push({ key: `concrete:${c.grade}`, label: grade ? `Concrete ${grade}` : 'Concrete (grade not set)', kind: 'concrete', grade, qty: c.m3, unit: 'm³' });
  }
  const add = (kind: MaterialKind, label: string, qty: number, unit: string) => qty > 0 && out.push({ key: kind, label, kind, qty, unit });
  add('cement', 'Cement', req.nonConcrete.cement, 'bags');
  add('sand', 'Sand', req.nonConcrete.sand, 'm³');
  add('bricks', 'Bricks', req.nonConcrete.bricks, 'nos');
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
    return (
      m?.kind === need.kind &&
      (need.kind !== 'steel' || m.dia === need.dia) &&
      // ready-mix of the same grade (an item without a grade in its name fits any grade)
      (need.kind !== 'concrete' || !m.grade || !need.grade || m.grade === need.grade) &&
      toReportUnit(need.kind, 1, i.uom, bagKg) !== null
    );
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

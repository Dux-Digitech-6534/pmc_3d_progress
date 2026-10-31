import { addMaterials, approvedOf, emptyMaterials, materialsFor, plannedOf, RCC_ELEMENT_TYPES, type MaterialNorms, type MaterialQty, type RccType } from './materials';
import { roundQty } from './progress';
import type { ElementRecord, ProgressEntry } from './types';

/**
 * Material required for a set of elements: concrete by grade, steel by bar diameter and the
 * other materials. "balance" = only the work not yet approved (what still has to be bought),
 * "planned" = the whole planned work of the elements.
 */
export type RequiredBasis = 'balance' | 'planned';

export interface MaterialRequired {
  elementCount: number;
  /** Concrete m³ per grade, highest quantity first. */
  concrete: { grade: string; m3: number; elements: number }[];
  /** Steel kg per bar diameter (mm), thin bars first; diameters with no steel are left out. */
  steel: { dia: number; kg: number }[];
  steelTotal: number;
  /** Where the bar sizes came from: the BBS of the uploaded elements, the typical mix of the planning, or both. */
  steelSource: 'bbs' | 'typical' | 'mixed' | 'none';
  shutteringM2: number;
  brickworkM3: number;
  plasterM2: number;
  /** Cement, sand, aggregate, steel, bricks (wastage included). */
  materials: MaterialQty;
}

const isRcc = (t: string): t is RccType => (RCC_ELEMENT_TYPES as readonly string[]).includes(t);

/** Work quantities left to do: planned less approved, never below 0. */
function balanceOf(el: ElementRecord, entries: ProgressEntry[]): Record<string, number> {
  const done = approvedOf(el, entries);
  return Object.fromEntries(Object.entries(plannedOf(el)).map(([k, q]) => [k, Math.max(q - (done[k] ?? 0), 0)]));
}

export function materialRequired(elements: ElementRecord[], entries: ProgressEntry[], norms: MaterialNorms, basis: RequiredBasis): MaterialRequired {
  const w = 1 + (norms.wastagePct || 0) / 100;
  const byGrade = new Map<string, { m3: number; elements: Set<string> }>();
  const byDia = new Map<number, number>();
  let shut = 0;
  let brick = 0;
  let plast = 0;
  let materials = emptyMaterials();
  let fromBbs = 0;
  let fromTypical = 0;
  for (const el of elements) {
    const q = basis === 'planned' ? plannedOf(el) : balanceOf(el, entries);
    materials = addMaterials(materials, materialsFor(q, norms));
    shut += q.SHUT ?? 0;
    brick += q.BRICK ?? 0;
    plast += q.PLAST ?? 0;
    const conc = q.CONC ?? 0;
    if (conc > 0) {
      const grade = el.concreteGrade?.trim() || (isRcc(el.type) && norms.gradeByType[el.type]) || 'Other';
      const g = byGrade.get(grade) ?? { m3: 0, elements: new Set<string>() };
      g.m3 += conc;
      g.elements.add(el.id);
      byGrade.set(grade, g);
    }
    const kg = (q.REINF ?? 0) * w;
    if (kg > 0) {
      // the BBS of the element when uploaded with it, else the typical bar mix of its type
      const bbs = el.steelByDia && Object.values(el.steelByDia).some((v) => v > 0) ? el.steelByDia : undefined;
      if (bbs) fromBbs++;
      else fromTypical++;
      const split = bbs ?? (isRcc(el.type) ? norms.steelSplit[el.type] : undefined);
      const parts = Object.entries(split ?? {}).filter(([, p]) => (p ?? 0) > 0);
      const sum = parts.reduce((a, [, p]) => a + (p ?? 0), 0);
      if (!sum) byDia.set(0, (byDia.get(0) ?? 0) + kg); // no split known: shown as "size not set"
      for (const [dia, p] of parts) byDia.set(Number(dia), (byDia.get(Number(dia)) ?? 0) + (kg * (p ?? 0)) / sum);
    }
  }
  const steel = [...byDia.entries()]
    .map(([dia, kg]) => ({ dia, kg: roundQty(kg, 1) }))
    .filter((s) => s.kg > 0)
    .sort((a, b) => (a.dia || 999) - (b.dia || 999));
  return {
    elementCount: elements.length,
    concrete: [...byGrade.entries()]
      .map(([grade, g]) => ({ grade, m3: roundQty(g.m3 * w, 3), elements: g.elements.size }))
      .sort((a, b) => b.m3 - a.m3),
    steel,
    steelSource: fromBbs && fromTypical ? 'mixed' : fromBbs ? 'bbs' : fromTypical ? 'typical' : 'none',
    steelTotal: roundQty(steel.reduce((a, s) => a + s.kg, 0), 1),
    shutteringM2: roundQty(shut, 2),
    brickworkM3: roundQty(brick * w, 3),
    plasterM2: roundQty(plast * w, 2),
    materials,
  };
}

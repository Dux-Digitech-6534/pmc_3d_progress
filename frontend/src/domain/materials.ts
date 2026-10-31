// Materials from planned / approved work quantities: cement, sand, aggregate, steel and bricks.
//
// The norms (material per m³ of concrete, per m³ of brickwork, per m² of plaster) are part of the
// planning — set in the Model Builder, approved by the PMC with the model and stored in the model
// document. The defaults are the usual nominal-mix values used for Indian estimates (IS 456 /
// DSR practice, dry volume factor 1.54 for concrete and 1.33 for mortar); every project can
// change them.

import type { ElementRecord, ElementType, ModelDocument, ProgressEntry } from './types';

export interface ConcreteNorm {
  /** Cement, kg per m³ of concrete. */
  cementKg: number;
  /** Sand (fine aggregate), m³ per m³ of concrete. */
  sandM3: number;
  /** Coarse aggregate (gitti), m³ per m³ of concrete. */
  aggregateM3: number;
}

export interface MaterialNorms {
  /** Label of the concrete mix, e.g. "M20 (1:1.5:3)". */
  concreteGrade: string;
  concrete: ConcreteNorm;
  /** Per m³ of brickwork (bricks with mortar). */
  brickwork: { bricks: number; cementKg: number; sandM3: number };
  /** Per m² of plaster. */
  plaster: { cementKg: number; sandM3: number };
  /** Added to every material, %. */
  wastagePct: number;
  /** Weight of one cement bag, kg. */
  bagKg: number;
  /** Concrete grade of each RCC element type (for "Material required" by grade). */
  gradeByType: Record<RccType, string>;
  /** Share of each RCC element type's steel by bar diameter (mm → %), adding up to 100. */
  steelSplit: Record<RccType, SteelSplit>;
}

export const RCC_ELEMENT_TYPES = ['footing', 'column', 'beam', 'slab', 'lintel', 'chhajja'] as const;
export type RccType = (typeof RCC_ELEMENT_TYPES)[number];
/** Bar diameters, mm. */
export const BAR_DIAS = [8, 10, 12, 16, 20, 25] as const;
export type SteelSplit = Partial<Record<string, number>>;
export const CONCRETE_GRADES = ['M15', 'M20', 'M25', 'M30', 'M35', 'M40'] as const;

/**
 * Typical bar mix of small RCC buildings when there is no bar bending schedule: ties / stirrups in
 * 8 mm, main bars 10–16 mm. Replace with the BBS split of the project.
 */
export const DEFAULT_STEEL_SPLIT: Record<RccType, SteelSplit> = {
  footing: { 10: 40, 12: 60 },
  column: { 8: 20, 12: 40, 16: 40 },
  beam: { 8: 25, 12: 45, 16: 30 },
  slab: { 8: 40, 10: 60 },
  lintel: { 8: 40, 10: 60 },
  chhajja: { 8: 50, 10: 50 },
};

/** Nominal mixes: 1 m³ of concrete needs 1.54 m³ of dry materials; cement 1440 kg/m³. */
export const CONCRETE_MIXES: Record<string, ConcreteNorm> = {
  'M15 (1:2:4)': { cementKg: 317, sandM3: 0.44, aggregateM3: 0.88 },
  'M20 (1:1.5:3)': { cementKg: 403, sandM3: 0.42, aggregateM3: 0.84 },
  'M25 (1:1:2)': { cementKg: 554, sandM3: 0.385, aggregateM3: 0.77 },
};

export const DEFAULT_MATERIAL_NORMS: MaterialNorms = {
  concreteGrade: 'M20 (1:1.5:3)',
  concrete: CONCRETE_MIXES['M20 (1:1.5:3)'],
  // modular bricks 190 × 90 × 90 with 10 mm joints; cement mortar 1:6, 0.25 m³ wet mortar per m³
  brickwork: { bricks: 500, cementKg: 68, sandM3: 0.285 },
  // 12 mm cement plaster 1:6
  plaster: { cementKg: 3.3, sandM3: 0.0137 },
  wastagePct: 0,
  bagKg: 50,
  gradeByType: { footing: 'M20', column: 'M20', beam: 'M20', slab: 'M20', lintel: 'M20', chhajja: 'M20' },
  steelSplit: DEFAULT_STEEL_SPLIT,
};

/** "M20 (1:1.5:3)" → "M20". */
export const gradeName = (label: string) => /^M\d+/.exec(label.trim())?.[0] ?? label.trim();

export const MATERIALS = [
  { key: 'cement', label: 'Cement', unit: 'bags' },
  { key: 'sand', label: 'Sand', unit: 'm³' },
  { key: 'aggregate', label: 'Aggregate (gitti)', unit: 'm³' },
  { key: 'steel', label: 'Steel', unit: 'kg' },
  { key: 'bricks', label: 'Bricks', unit: 'nos' },
] as const;

export type MaterialKey = (typeof MATERIALS)[number]['key'];
export type MaterialQty = Record<MaterialKey, number>;

export const emptyMaterials = (): MaterialQty => ({ cement: 0, sand: 0, aggregate: 0, steel: 0, bricks: 0 });

const DECIMALS: Record<MaterialKey, number> = { cement: 1, sand: 2, aggregate: 2, steel: 1, bricks: 0 };
export const roundMaterial = (k: MaterialKey, n: number) => {
  const f = 10 ** DECIMALS[k];
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** Norms of a model: the ones planned with it, or the defaults for models made before norms existed. */
export function normsOf(doc: ModelDocument | undefined | null): MaterialNorms {
  const saved = (doc?.model.source as { materialNorms?: Partial<MaterialNorms> } | undefined)?.materialNorms;
  return withNormDefaults(saved);
}

export function withNormDefaults(n: Partial<MaterialNorms> | undefined): MaterialNorms {
  const d = DEFAULT_MATERIAL_NORMS;
  return {
    ...d,
    ...n,
    concrete: { ...d.concrete, ...n?.concrete },
    brickwork: { ...d.brickwork, ...n?.brickwork },
    plaster: { ...d.plaster, ...n?.plaster },
    // a model planned before grades by type existed: every type has the model's grade
    gradeByType: { ...(n?.gradeByType ? d.gradeByType : Object.fromEntries(RCC_ELEMENT_TYPES.map((t) => [t, gradeName(n?.concreteGrade ?? d.concreteGrade)]))), ...n?.gradeByType } as Record<RccType, string>,
    steelSplit: { ...d.steelSplit, ...n?.steelSplit },
  };
}

/** Problems with the norms, in plain words (empty when fine). */
export function normErrors(n: MaterialNorms): string[] {
  const out: string[] = [];
  const ok = (v: number) => Number.isFinite(v) && v >= 0;
  if (![n.concrete.cementKg, n.concrete.sandM3, n.concrete.aggregateM3].every(ok)) out.push('Concrete norms must be numbers of 0 or more.');
  if (![n.brickwork.bricks, n.brickwork.cementKg, n.brickwork.sandM3].every(ok)) out.push('Brickwork norms must be numbers of 0 or more.');
  if (![n.plaster.cementKg, n.plaster.sandM3].every(ok)) out.push('Plaster norms must be numbers of 0 or more.');
  if (!ok(n.wastagePct) || n.wastagePct > 50) out.push('Wastage must be between 0 and 50 %.');
  if (!(Number.isFinite(n.bagKg) && n.bagKg > 0)) out.push('Cement bag weight must be more than 0 kg.');
  for (const t of RCC_ELEMENT_TYPES) {
    const parts = Object.values(n.steelSplit[t] ?? {}).map((v) => v ?? 0);
    if (!parts.every(ok)) out.push(`Steel bar sizes for ${t}: percentages must be 0 or more.`);
    else if (Math.abs(parts.reduce((a, b) => a + b, 0) - 100) > 0.5) out.push(`Steel bar sizes for ${t} must add up to 100 %.`);
  }
  return out;
}

/**
 * Materials for work quantities by activity code (CONC m³, BRICK m³, PLAST m², REINF kg):
 * concrete → cement, sand, aggregate; brickwork → bricks, cement, sand; plaster → cement, sand;
 * reinforcement → steel. Wastage is added to everything.
 */
export function materialsFor(qty: Partial<Record<string, number>>, norms: MaterialNorms): MaterialQty {
  const conc = qty.CONC ?? 0;
  const brick = qty.BRICK ?? 0;
  const plast = qty.PLAST ?? 0;
  const w = 1 + (norms.wastagePct || 0) / 100;
  const cementKg = conc * norms.concrete.cementKg + brick * norms.brickwork.cementKg + plast * norms.plaster.cementKg;
  return {
    cement: (cementKg / norms.bagKg) * w,
    sand: (conc * norms.concrete.sandM3 + brick * norms.brickwork.sandM3 + plast * norms.plaster.sandM3) * w,
    aggregate: conc * norms.concrete.aggregateM3 * w,
    steel: (qty.REINF ?? 0) * w,
    bricks: brick * norms.brickwork.bricks * w,
  };
}

export const addMaterials = (a: MaterialQty, b: MaterialQty): MaterialQty => ({
  cement: a.cement + b.cement,
  sand: a.sand + b.sand,
  aggregate: a.aggregate + b.aggregate,
  steel: a.steel + b.steel,
  bricks: a.bricks + b.bricks,
});

/** Planned work quantities of an element, by activity code. */
export const plannedOf = (el: Pick<ElementRecord, 'plannedQuantities'>): Record<string, number> =>
  Object.fromEntries(Object.entries(el.plannedQuantities).map(([k, q]) => [k, q.quantity]));

/** Approved work quantities of an element (only approved entries count, in the planned unit). */
export function approvedOf(el: Pick<ElementRecord, 'id' | 'plannedQuantities'>, entries: ProgressEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    if (e.elementId !== el.id || e.status !== 'Approved') continue;
    const unit = el.plannedQuantities[e.activityCode]?.unit;
    if (unit && e.unit !== unit) continue;
    out[e.activityCode] = (out[e.activityCode] ?? 0) + e.quantity;
  }
  return out;
}

export interface MaterialRow {
  type: ElementType;
  count: number;
  planned: MaterialQty;
  used: MaterialQty;
}

/** Materials per element type and in total: planned (from the model) and used (from approved work). */
export function projectMaterials(elements: ElementRecord[], entries: ProgressEntry[], norms: MaterialNorms) {
  const rows = new Map<ElementType, MaterialRow>();
  let planned = emptyMaterials();
  let used = emptyMaterials();
  for (const el of elements) {
    const p = materialsFor(plannedOf(el), norms);
    const u = materialsFor(approvedOf(el, entries), norms);
    const row = rows.get(el.type) ?? { type: el.type, count: 0, planned: emptyMaterials(), used: emptyMaterials() };
    row.count++;
    row.planned = addMaterials(row.planned, p);
    row.used = addMaterials(row.used, u);
    rows.set(el.type, row);
    planned = addMaterials(planned, p);
    used = addMaterials(used, u);
  }
  return { rows: [...rows.values()].filter((r) => MATERIALS.some((m) => r.planned[m.key] > 0)), planned, used };
}

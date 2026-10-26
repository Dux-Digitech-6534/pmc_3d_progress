// Model Builder: turns the values an engineer reads off a PDF / image drawing (grid, column and
// footing schedules, beam and slab sizes, levels, walls, door/window schedule) into a
// pmc-procedural-model v1 document. The result goes through the normal import pipeline
// (validation, revisions, register), so a built model behaves exactly like an imported JSON file.
//
// Inputs are in millimetres, like the drawings. Output geometry is in metres, Y up, ground = 0.
// Quantities: concrete (m3) and shuttering (m2) come from the geometry; reinforcement (kg) uses
// the kg-per-m3 rate entered for each element type until a bar bending schedule (BBS) is available.
// Brickwork (m3) and plaster (m2) are net of openings (and lintels for brickwork).

import { addMaterials, emptyMaterials, materialsFor, normErrors, withNormDefaults, type MaterialNorms, type MaterialQty } from './materials';
import { ELEMENT_TYPES, type ElementType, type ModelDocument, type WallOpening } from './types';

export interface ColumnType {
  code: string; // C1
  w: number; // mm, along X
  d: number; // mm, along Z
  footing: string; // footing code, e.g. F1
}

export interface FootingType {
  code: string; // F1
  w: number; // mm
  d: number; // mm
  t: number; // mm, footing thickness ("D" in the schedule)
}

export interface BeamSize {
  enabled: boolean;
  w: number; // mm
  h: number; // mm
}

export interface SteelRates {
  footing: number; // kg per m3
  column: number;
  beam: number; // also used for lintels
  slab: number; // also used for chhajjas
}

export type OpeningKind = 'door' | 'window' | 'ventilator';

/** One row of the door / window / ventilator schedule on the drawing (mm). */
export interface OpeningType {
  mark: string; // D, D1, W, V
  kind: OpeningKind;
  w: number;
  h: number;
  /** Sill height above floor (0 for doors), mm. */
  sill: number;
}

/** Where an opening sits: which wall, and how far along it. */
export interface OpeningPlacement {
  mark: string;
  /** Wall key, e.g. "X1Y1-X2Y1" (between those two grid points). */
  wall: string;
  /** Distance from the wall's first grid point to the opening centre, mm. null = centred in the wall. */
  offset: number | null;
}

/** What the Model Builder makes: a column-grid building, a boundary wall, or free elements. */
export type StructureKind = 'building' | 'boundary' | 'free';

/**
 * One element of a free model (mm): centre on the plan (x from the left, y from the front /
 * bottom edge of the plan), bottom level z above ground (negative below), and its size: l along
 * plan X, w along plan Y, h height.
 */
export interface FreeElement {
  code: string;
  type: ElementType;
  x: number;
  y: number;
  z: number;
  l: number;
  w: number;
  h: number;
}

export interface BuilderSpec {
  /**
   * building (default): columns on an X × Y grid, beams, roof slab, walls between columns.
   * boundary: piers on a line (no Y spacing) or around a plot (outer grid points only), plinth
   * and top beams between neighbouring piers, wall panels, no slab.
   * free: the elements are listed one by one (freeElements) — for anything the templates do not fit.
   */
  kind?: StructureKind;
  /** The elements of a free model. */
  freeElements?: FreeElement[];
  /**
   * Elements added by hand on top of a building / boundary wall template (a wall, a footing …).
   * Same box format as a free model, with x / y measured from the model centre (mm).
   */
  extraElements?: FreeElement[];
  projectId: string;
  projectName: string;
  location?: string;
  modelId: string;
  modelName: string;
  revision: string;
  buildingName: string;
  /** Centre-to-centre spacing between grid lines, mm. X1→X2, X2→X3 … */
  xSpans: number[];
  /** Y1→Y2, Y2→Y3 … (shown as depth / Z in 3D) */
  ySpans: number[];
  columnTypes: ColumnType[];
  footingTypes: FootingType[];
  /** layout[yIndex][xIndex] = column type code at that grid point, or "" for none. */
  layout: string[][];
  /** Depth of footing bottom below ground level, mm. */
  foundationDepth: number;
  /** Top of roof beams / bottom of slab, mm above ground level. */
  roofLevel: number;
  plinthBeam: BeamSize;
  roofBeam: BeamSize;
  slab: { enabled: boolean; t: number; overhang: number };
  steel: SteelRates;
  /** Brick / block walls on grid lines, between column faces, from plinth top to roof beam bottom. */
  walls: { enabled: boolean; t: number; internal: boolean };
  openingTypes: OpeningType[];
  openings: OpeningPlacement[];
  /** RCC lintel over every opening: depth, and bearing into the wall on each side (mm). */
  lintel: { enabled: boolean; h: number; bearing: number };
  /** Chhajja (sunshade) projecting outside, over openings on outer walls (mm). */
  chhajja: { enabled: boolean; projection: number; t: number; overDoors: boolean };
  /** Names of the drawings the values were taken from (stored as provenance). */
  drawingRefs: string[];
  /**
   * Single elements the user removed by clicking them in the 3D preview, by element code
   * (beams "PB-…" / "RB-…", walls "W-…", lintels "L-…", chhajjas "CH-…"). Columns, footings,
   * doors / windows and the slab are removed through the layout, placements and slab switch.
   */
  omit?: string[];
  /**
   * Planned quantities typed in by hand, by element code and activity code (e.g.
   * { "F1-X1Y1": { REINF: 31.5 } }). They replace the calculated value; without an entry the
   * quantity is calculated ("Auto").
   */
  qtyOverride?: Record<string, Record<string, number>>;
  /** Material norms (per m³ concrete / brickwork, per m² plaster); standard values when not set. */
  materialNorms?: MaterialNorms;
}

/** What a generated element comes from in the spec, so a click in the 3D preview can edit it. */
export type ElementRef =
  | { kind: 'column' | 'footing'; xi: number; yi: number }
  | { kind: 'beam'; code: string; tag: 'PB' | 'RB' }
  | { kind: 'wall'; code: string; wall: string }
  | { kind: 'opening'; row: number }
  | { kind: 'lintel' | 'chhajja'; code: string; row: number }
  | { kind: 'slab' }
  | { kind: 'free'; index: number }
  | { kind: 'extra'; index: number };

export interface BuildSummary {
  footings: number;
  columns: number;
  beams: number;
  slabs: number;
  walls: number;
  doors: number;
  windows: number;
  lintels: number;
  chhajjas: number;
  concrete: number;
  shuttering: number;
  steel: number;
  brickwork: number;
  plaster: number;
  /** Cement (bags), sand, aggregate, steel, bricks for the planned quantities. */
  materials?: MaterialQty;
}

export interface BuildResult {
  errors: string[];
  warnings: string[];
  document: ModelDocument | null;
  summary: BuildSummary | null;
  /** Element id → where it comes from in the spec. */
  refs: Record<string, ElementRef>;
  /** Element id → the calculated planned quantity per activity, before any typed-in value. */
  auto: Record<string, Record<string, number>>;
}

const RCC_TYPES: ElementType[] = ['footing', 'column', 'beam', 'slab', 'lintel', 'chhajja'];

/** The activities every built model has, and the element types each applies to. */
export const ACTIVITIES: { code: string; name: string; unit: 'kg' | 'm2' | 'm3' | 'nos'; appliesTo: ElementType[] }[] = [
  { code: 'REINF', name: 'Reinforcement', unit: 'kg', appliesTo: RCC_TYPES },
  { code: 'SHUT', name: 'Shuttering', unit: 'm2', appliesTo: RCC_TYPES },
  { code: 'CONC', name: 'Concreting', unit: 'm3', appliesTo: RCC_TYPES },
  { code: 'BRICK', name: 'Brickwork', unit: 'm3', appliesTo: ['wall'] },
  { code: 'PLAST', name: 'Plaster', unit: 'm2', appliesTo: ['wall'] },
  { code: 'FIX', name: 'Fixing', unit: 'nos', appliesTo: ['door', 'window'] },
];
const SUMMARY_KEY: Record<string, 'concrete' | 'shuttering' | 'steel' | 'brickwork' | 'plaster' | undefined> = {
  CONC: 'concrete',
  SHUT: 'shuttering',
  REINF: 'steel',
  BRICK: 'brickwork',
  PLAST: 'plaster',
};

const r = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const mm = (n: number) => n / 1000;
const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const EPS = 1e-6;

export const gridLabel = (axis: 'X' | 'Y', i: number) => `${axis}${i + 1}`;

/** Blank layout of the given size, every grid point filled with `fill`. */
export function makeLayout(nx: number, ny: number, fill: string): string[][] {
  return Array.from({ length: ny }, () => Array.from({ length: nx }, () => fill));
}

/** Keep existing cells when the grid size changes. */
export function resizeLayout(layout: string[][], nx: number, ny: number, fill: string): string[][] {
  return Array.from({ length: ny }, (_, y) => Array.from({ length: nx }, (_, x) => layout[y]?.[x] ?? fill));
}

/**
 * Parse "3230, 2115" or "3230 2115" into numbers (mm); "3000*40" (or 3000x40) is 40 spacings of
 * 3000. Returns null if any part is not a positive number; an empty text gives [] when allowEmpty
 * (a boundary wall on one line has no Y spacing).
 */
export function parseSpans(text: string, allowEmpty = false): number[] | null {
  const nums: number[] = [];
  for (const part of text.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)[*x×](\d+)$/i.exec(part);
    if (!m) {
      nums.push(Number(part));
      continue;
    }
    const times = Number(m[2]);
    if (!(times >= 1 && times <= 400)) return null;
    for (let i = 0; i < times; i++) nums.push(Number(m[1]));
  }
  if (!nums.length) return allowEmpty ? [] : null;
  return nums.every(pos) ? nums : null;
}

/** Spacings as text, repeated values written as "3000*40". */
export function formatSpans(spans: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < spans.length; ) {
    let j = i;
    while (j < spans.length && spans[j] === spans[i]) j++;
    const n = j - i;
    out.push(n >= 3 ? `${spans[i]}*${n}` : Array(n).fill(String(spans[i])).join(', '));
    i = j;
  }
  return out.join(', ');
}

export const kindOf = (spec: Pick<BuilderSpec, 'kind'>): StructureKind => spec.kind ?? 'building';

/** Problems with the project / model names (section 1). */
export function headerErrors(spec: BuilderSpec): string[] {
  const errors: string[] = [];
  if (!spec.projectId.trim() || !ID_RE.test(spec.projectId.trim())) errors.push('Project ID is required (letters, digits, - _ . only), e.g. PMC-SEC-003.');
  if (!spec.projectName.trim()) errors.push('Project name is required.');
  if (!spec.modelId.trim() || !ID_RE.test(spec.modelId.trim())) errors.push('Model ID is required (letters, digits, - _ . only), e.g. SEC-CABIN-D85.');
  if (!spec.revision.trim()) errors.push('Revision is required, e.g. R01.');
  if (!spec.buildingName.trim()) errors.push('Building name is required.');
  return errors;
}

export function buildModel(spec: BuilderSpec): BuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const refs: Record<string, ElementRef> = {};
  const omit = new Set(spec.omit ?? []);
  const fail = (): BuildResult => ({ errors, warnings, document: null, summary: null, refs: {}, auto: {} });

  errors.push(...headerErrors(spec));
  if (kindOf(spec) === 'free') return buildFree(spec, errors, warnings);
  const boundary = kindOf(spec) === 'boundary';

  // ---- grid ----
  if (!spec.xSpans.every(pos)) errors.push('X spacings must be positive numbers (mm).');
  if (!spec.ySpans.every(pos)) errors.push('Y spacings must be positive numbers (mm).');
  const nx = spec.xSpans.length + 1;
  const ny = spec.ySpans.length + 1;
  if (nx * ny > 400) errors.push(`The grid has ${nx * ny} points; the builder supports up to 400.`);

  // ---- schedules ----
  const footings = new Map<string, FootingType>();
  spec.footingTypes.forEach((f, i) => {
    const code = f.code.trim();
    if (!code) return errors.push(`Footing schedule row ${i + 1}: code is required.`);
    if (footings.has(code)) errors.push(`Footing code "${code}" is used twice.`);
    if (!pos(f.w) || !pos(f.d) || !pos(f.t)) errors.push(`Footing ${code}: length, width and depth (D) must be positive (mm).`);
    footings.set(code, { ...f, code });
  });
  const columns = new Map<string, ColumnType>();
  spec.columnTypes.forEach((c, i) => {
    const code = c.code.trim();
    if (!code) return errors.push(`Column schedule row ${i + 1}: code is required.`);
    if (columns.has(code)) errors.push(`Column code "${code}" is used twice.`);
    if (!pos(c.w) || !pos(c.d)) errors.push(`Column ${code}: size must be positive (mm).`);
    if (!footings.has(c.footing.trim())) errors.push(`Column ${code}: footing "${c.footing}" is not in the footing schedule.`);
    columns.set(code, { ...c, code, footing: c.footing.trim() });
  });
  const openingTypes = new Map<string, OpeningType>();
  spec.openingTypes.forEach((o, i) => {
    const mark = o.mark.trim();
    if (!mark) return errors.push(`Door/window schedule row ${i + 1}: mark is required.`);
    if (openingTypes.has(mark)) errors.push(`Door/window mark "${mark}" is used twice.`);
    if (!pos(o.w) || !pos(o.h) || !(o.sill >= 0)) errors.push(`Opening ${mark}: width and height must be positive, sill 0 or more (mm).`);
    openingTypes.set(mark, { ...o, mark });
  });

  // ---- levels / members ----
  if (!pos(spec.foundationDepth)) errors.push('Foundation depth (footing bottom below ground) must be positive (mm).');
  if (!pos(spec.roofLevel)) errors.push('Roof level must be positive (mm above ground).');
  if (spec.plinthBeam.enabled && (!pos(spec.plinthBeam.w) || !pos(spec.plinthBeam.h))) errors.push('Plinth beam size must be positive (mm).');
  if (spec.roofBeam.enabled && (!pos(spec.roofBeam.w) || !pos(spec.roofBeam.h))) errors.push('Roof beam size must be positive (mm).');
  if (spec.slab.enabled && !pos(spec.slab.t)) errors.push('Slab thickness must be positive (mm).');
  if (spec.slab.enabled && !(spec.slab.overhang >= 0)) errors.push('Slab overhang cannot be negative.');
  if (spec.walls.enabled && !pos(spec.walls.t)) errors.push('Wall thickness must be positive (mm).');
  if (spec.lintel.enabled && (!pos(spec.lintel.h) || !(spec.lintel.bearing >= 0))) errors.push('Lintel depth must be positive and bearing 0 or more (mm).');
  if (spec.chhajja.enabled && (!pos(spec.chhajja.projection) || !pos(spec.chhajja.t))) errors.push('Chhajja projection and thickness must be positive (mm).');
  (['footing', 'column', 'beam', 'slab'] as const).forEach((k) => {
    if (!(spec.steel[k] >= 0)) errors.push(`Steel rate for ${k} must be 0 or more (kg/m³).`);
  });
  if (errors.length) return fail();

  // ---- grid coordinates (centred on 0) ----
  const cum = (spans: number[]) => spans.reduce<number[]>((a, s) => [...a, a[a.length - 1] + mm(s)], [0]);
  const xsRaw = cum(spec.xSpans);
  const zsRaw = cum(spec.ySpans);
  const xs = xsRaw.map((x) => r(x - xsRaw[xsRaw.length - 1] / 2, 4));
  // Y1 is the bottom edge of the plan (the front). The default camera looks from +Z, so Y grows
  // towards -Z: the 3D view then reads like the drawing, with X1 on the left and Y1 in front.
  const zs = zsRaw.map((z) => r(zsRaw[zsRaw.length - 1] / 2 - z, 4) + 0);

  type Pt = { xi: number; yi: number; col: ColumnType; foot: FootingType; key: string };
  const pts: Pt[] = [];
  for (let yi = 0; yi < ny; yi++) {
    for (let xi = 0; xi < nx; xi++) {
      const code = (spec.layout[yi]?.[xi] ?? '').trim();
      if (!code) continue;
      const col = columns.get(code);
      if (!col) {
        errors.push(`Grid point ${gridLabel('X', xi)}/${gridLabel('Y', yi)} uses column "${code}", which is not in the column schedule.`);
        continue;
      }
      pts.push({ xi, yi, col, foot: footings.get(col.footing)!, key: `${gridLabel('X', xi)}${gridLabel('Y', yi)}` });
    }
  }
  if (!pts.length) errors.push('Place at least one column on the grid.');
  if (errors.length) return fail();

  const prefix = spec.modelId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'MDL';
  const bId = `BLD-${prefix}`;
  const depth = mm(spec.foundationDepth);
  const roof = mm(spec.roofLevel);
  const elements: ModelDocument['elements'] = [];
  const sum: BuildSummary = {
    footings: 0,
    columns: 0,
    beams: 0,
    slabs: 0,
    walls: 0,
    doors: 0,
    windows: 0,
    lintels: 0,
    chhajjas: 0,
    concrete: 0,
    shuttering: 0,
    steel: 0,
    brickwork: 0,
    plaster: 0,
  };
  const qty = (conc: number, shut: number, rate: number) => {
    sum.concrete += conc;
    sum.shuttering += shut;
    const q: Record<string, { quantity: number; unit: 'kg' | 'm2' | 'm3' }> = {
      SHUT: { quantity: r(shut, 2), unit: 'm2' },
      CONC: { quantity: r(conc, 3), unit: 'm3' },
    };
    if (rate > 0) {
      q.REINF = { quantity: r(conc * rate, 1), unit: 'kg' };
      sum.steel += conc * rate;
    }
    return q;
  };

  // ---- footings + columns ----
  pts.forEach((p) => {
    const fw = mm(p.foot.w), fd = mm(p.foot.d), ft = mm(p.foot.t);
    if (ft >= depth) warnings.push(`Footing ${p.foot.code} at ${p.key} is deeper (${p.foot.t} mm) than the foundation depth; it would stick out of the ground.`);
    elements.push({
      id: `${prefix}-FTG-${p.key}`,
      code: `${p.foot.code}-${p.key}`,
      type: 'footing',
      buildingId: bId,
      levelId: 'FDN',
      geometry: { shape: 'box', position: [xs[p.xi], r(-depth + ft / 2, 4), zs[p.yi]], size: [fw, r(ft, 4), fd] },
      plannedQuantities: qty(fw * fd * ft, 2 * (fw + fd) * ft, spec.steel.footing),
      notes: `Footing ${p.foot.code} ${p.foot.w}×${p.foot.d}, D ${p.foot.t} mm`,
    });
    refs[`${prefix}-FTG-${p.key}`] = { kind: 'footing', xi: p.xi, yi: p.yi };
    sum.footings++;
    const cw = mm(p.col.w), cd = mm(p.col.d);
    const bottom = -depth + ft;
    const h = roof - bottom;
    elements.push({
      id: `${prefix}-COL-${p.key}`,
      code: `${p.col.code}-${p.key}`,
      type: 'column',
      buildingId: bId,
      levelId: 'GF',
      geometry: { shape: 'box', position: [xs[p.xi], r(bottom + h / 2, 4), zs[p.yi]], size: [cw, r(h, 4), cd] },
      plannedQuantities: qty(cw * cd * h, 2 * (cw + cd) * h, spec.steel.column),
      notes: `Column ${p.col.code} ${p.col.w}×${p.col.d} mm, from footing top to roof level`,
    });
    refs[`${prefix}-COL-${p.key}`] = { kind: 'column', xi: p.xi, yi: p.yi };
    sum.columns++;
  });

  // ---- spans between consecutive columns along every grid line ----
  type Span = { a: Pt; b: Pt; axis: 'x' | 'z' };
  const spans: Span[] = [];
  for (let yi = 0; yi < ny; yi++) {
    const row = pts.filter((p) => p.yi === yi).sort((a, b) => a.xi - b.xi);
    // a boundary wall only joins neighbouring piers (around a plot, never across it)
    row.slice(0, -1).forEach((a, i) => (!boundary || row[i + 1].xi - a.xi === 1) && spans.push({ a, b: row[i + 1], axis: 'x' }));
  }
  for (let xi = 0; xi < nx; xi++) {
    const line = pts.filter((p) => p.xi === xi).sort((a, b) => a.yi - b.yi);
    line.slice(0, -1).forEach((a, i) => (!boundary || line[i + 1].yi - a.yi === 1) && spans.push({ a, b: line[i + 1], axis: 'z' }));
  }
  /** Clear span between the two column faces and its mid-point along the span axis (metres). */
  const clearSpan = (s: Span) => {
    const ax = s.axis === 'x';
    const ga = ax ? xs[s.a.xi] : zs[s.a.yi];
    const gb = ax ? xs[s.b.xi] : zs[s.b.yi];
    const dir = gb >= ga ? 1 : -1; // Z decreases from Y1 to Y2
    const start = ga + (dir * (ax ? mm(s.a.col.w) : mm(s.a.col.d))) / 2;
    const end = gb - (dir * (ax ? mm(s.b.col.w) : mm(s.b.col.d))) / 2;
    return { len: (end - start) * dir, mid: (start + end) / 2, ga, dir };
  };
  const lineOf = (s: Span) => (s.axis === 'x' ? zs[s.a.yi] : xs[s.a.xi]);
  const spanKey = (s: Span) => `${s.a.key}-${s.b.key}`;
  const isOuter = (s: Span) => (s.axis === 'x' ? s.a.yi === 0 || s.a.yi === ny - 1 : s.a.xi === 0 || s.a.xi === nx - 1);

  // ---- beams ----
  const addBeams = (tag: 'PB' | 'RB', levelId: string, top: number, size: BeamSize, label: string) => {
    if (!size.enabled) return;
    const w = mm(size.w), h = mm(size.h);
    spans.forEach((s) => {
      const ax = s.axis === 'x';
      const code = `${tag}-${spanKey(s)}`;
      if (omit.has(code)) return;
      const { len, mid } = clearSpan(s);
      if (len <= 0) {
        warnings.push(`${label} ${s.a.key}–${s.b.key}: columns touch, no beam generated.`);
        return;
      }
      elements.push({
        id: `${prefix}-${code}`,
        code,
        type: 'beam',
        buildingId: bId,
        levelId,
        geometry: {
          shape: 'box',
          position: ax ? [r(mid, 4), r(top - h / 2, 4), lineOf(s)] : [lineOf(s), r(top - h / 2, 4), r(mid, 4)],
          size: ax ? [r(len, 4), r(h, 4), w] : [w, r(h, 4), r(len, 4)],
        },
        plannedQuantities: qty(w * h * len, (2 * h + w) * len, spec.steel.beam),
        notes: `${label} ${size.w}×${size.h} mm, clear span ${Math.round(len * 1000)} mm`,
      });
      refs[`${prefix}-${code}`] = { kind: 'beam', code, tag };
      sum.beams++;
    });
  };
  addBeams('PB', 'GF', 0, spec.plinthBeam, 'Plinth beam');
  addBeams('RB', 'RF', roof, spec.roofBeam, boundary ? 'Top (coping) beam' : 'Roof beam');
  if (!spans.length && (spec.plinthBeam.enabled || spec.roofBeam.enabled)) warnings.push('Only one column on a grid line: no beams were generated.');

  // ---- walls with door / window openings, lintels and chhajjas ----
  if (spec.walls.enabled) {
    const t = mm(spec.walls.t);
    // Walls stand on the plinth (top at ground level 0) and go up to the roof beam soffit.
    const H = spec.roofBeam.enabled ? roof - mm(spec.roofBeam.h) : roof;
    if (!(H > 0)) errors.push('Roof level is not above the roof beam depth: walls would have no height.');

    const byWall = new Map<string, { p: OpeningPlacement; ot: OpeningType; row: number }[]>();
    spec.openings.forEach((p, row) => {
      const ot = openingTypes.get(p.mark.trim());
      if (!ot) return errors.push(`Opening row ${row + 1}: mark "${p.mark}" is not in the door/window schedule.`);
      byWall.set(p.wall, [...(byWall.get(p.wall) ?? []), { p, ot, row }]);
    });

    const wallSpans = spans.filter((s) => ((spec.walls.internal && !boundary) || isOuter(s)) && !omit.has(`W-${spanKey(s)}`));
    const wallKeys = new Set(wallSpans.map(spanKey));
    spec.openings.forEach((p, row) => {
      if (!wallKeys.has(p.wall)) errors.push(`Opening row ${row + 1}: wall "${p.wall}" does not exist for this grid / column layout.`);
    });

    if (H > 0) {
      wallSpans.forEach((s) => {
        const ax = s.axis === 'x';
        const key = spanKey(s);
        const { len: L, mid, ga, dir } = clearSpan(s);
        if (L <= 0) return;
        const line = lineOf(s);
        const outSign = line > EPS ? 1 : line < -EPS ? -1 : 0; // which side is outside (away from the centre)
        const at = (along: number, y: number): [number, number, number] => (ax ? [r(mid + along, 4), r(y, 4), line] : [line, r(y, 4), r(mid + along, 4)]);

        const openings: WallOpening[] = [];
        const placed: { mark: string; row: number; from: number; to: number }[] = []; // mm from the wall's first grid point, for messages
        let lintelVol = 0;
        (byWall.get(key) ?? []).forEach(({ p, ot, row }, n) => {
          const w = mm(ot.w), h = mm(ot.h);
          const sill = ot.kind === 'door' ? 0 : mm(ot.sill); // doors always start at the floor, whatever was typed
          const c = p.offset === null || !Number.isFinite(p.offset) ? 0 : ga + dir * mm(p.offset) - mid; // from wall centre, world axis
          const label = `Opening row ${row + 1} (${ot.mark} on wall ${key})`;
          const posMm = Math.round((mid + c - ga) * dir * 1000); // centre, mm from the first grid point
          const from = posMm - ot.w / 2;
          const to = posMm + ot.w / 2;
          if (c - w / 2 < -L / 2 - EPS || c + w / 2 > L / 2 + EPS) {
            const lo = Math.round((mid - L / 2 - ga) * dir * 1000);
            const hi = Math.round((mid + L / 2 - ga) * dir * 1000);
            const [a, b] = lo < hi ? [lo, hi] : [hi, lo];
            return errors.push(
              ot.w > Math.round(L * 1000)
                ? `${label}: ${ot.w} mm is wider than the ${Math.round(L * 1000)} mm wall between the columns. Use a smaller size or another wall.`
                : `${label}: at position ${posMm} it runs from ${from} to ${to} mm, outside the wall (${a}–${b} mm between the column faces). Use a position from ${a + ot.w / 2} to ${b - ot.w / 2}.`,
            );
          }
          if (sill + h > H + EPS) return errors.push(`${label}: sill ${ot.sill} + height ${ot.h} mm is taller than the ${Math.round(H * 1000)} mm wall.`);
          const hit = openings.findIndex((o) => Math.abs(o.center - c) < (o.width + w) / 2 - EPS && sill < o.bottom + o.height - EPS && o.bottom < sill + h - EPS);
          if (hit >= 0) {
            const o = placed[hit];
            const [lo, hi] = [Math.max(Math.min(from, to), Math.min(o.from, o.to)), Math.min(Math.max(from, to), Math.max(o.from, o.to))];
            return errors.push(
              `${label}: ${ot.mark} (${Math.min(from, to)}–${Math.max(from, to)} mm) overlaps ${o.mark} from row ${o.row + 1} (${Math.min(o.from, o.to)}–${Math.max(o.from, o.to)} mm) between ${lo} and ${hi} mm. Move one of them with ◀ ▶, or put it on another wall.`,
            );
          }
          openings.push({ center: r(c, 4), bottom: r(sill, 4), width: w, height: h });
          placed.push({ mark: ot.mark, row, from, to });

          // door / window shutter panel inside the opening
          const isDoor = ot.kind === 'door';
          const panelT = Math.min(0.04, t / 2);
          elements.push({
            id: `${prefix}-OPN-${key}-${n + 1}`,
            code: `${ot.mark}-${key}`,
            type: isDoor ? 'door' : 'window',
            buildingId: bId,
            levelId: 'GF',
            geometry: { shape: 'box', position: at(c, sill + h / 2), size: ax ? [w, h, panelT] : [panelT, h, w] },
            plannedQuantities: { FIX: { quantity: 1, unit: 'nos' } },
            notes: `${ot.kind[0].toUpperCase()}${ot.kind.slice(1)} ${ot.mark} ${ot.w}×${ot.h} mm, sill ${ot.sill} mm`,
          });
          refs[`${prefix}-OPN-${key}-${n + 1}`] = { kind: 'opening', row };
          if (isDoor) sum.doors++;
          else sum.windows++;

          // RCC lintel over the opening
          const top = sill + h;
          let lintelTop = top;
          const bearing = mm(spec.lintel.bearing);
          const lintelCode = `L-${ot.mark}-${key}`;
          if (spec.lintel.enabled && !omit.has(lintelCode)) {
            const lh = mm(spec.lintel.h);
            if (top + lh > H + EPS) {
              warnings.push(`${ot.mark} on wall ${key}: no room for a ${spec.lintel.h} mm lintel under the roof beam — the roof beam acts as lintel.`);
            } else {
              const lo = Math.max(c - w / 2 - bearing, -L / 2);
              const hi = Math.min(c + w / 2 + bearing, L / 2);
              const ll = hi - lo;
              // Drawn 10 mm thicker than the wall so it shows on both wall faces; quantities use the wall thickness.
              const lt = r(t + 0.01, 4);
              elements.push({
                id: `${prefix}-LNT-${key}-${n + 1}`,
                code: lintelCode,
                type: 'lintel',
                buildingId: bId,
                levelId: 'GF',
                geometry: { shape: 'box', position: at((lo + hi) / 2, top + lh / 2), size: ax ? [r(ll, 4), r(lh, 4), lt] : [lt, r(lh, 4), r(ll, 4)] },
                plannedQuantities: qty(ll * t * lh, 2 * lh * ll + t * w, spec.steel.beam),
                notes: `RCC lintel ${Math.round(ll * 1000)} × ${spec.walls.t} × ${spec.lintel.h} mm over ${ot.mark}`,
              });
              refs[`${prefix}-LNT-${key}-${n + 1}`] = { kind: 'lintel', code: lintelCode, row };
              lintelVol += ll * t * lh;
              lintelTop = top + lh;
              sum.lintels++;
            }
          }

          // chhajja outside, over windows (and doors if chosen), on outer walls only
          const chhajjaCode = `CH-${ot.mark}-${key}`;
          if (spec.chhajja.enabled && !boundary && isOuter(s) && outSign !== 0 && (!isDoor || spec.chhajja.overDoors) && !omit.has(chhajjaCode)) {
            const pr = mm(spec.chhajja.projection), ct = mm(spec.chhajja.t);
            const cl = Math.min(w + 2 * bearing, L);
            const cc = Math.max(Math.min(c, L / 2 - cl / 2), -L / 2 + cl / 2);
            const cp = at(cc, lintelTop - ct / 2);
            const off = r(line + outSign * (t / 2 + pr / 2), 4);
            if (ax) cp[2] = off;
            else cp[0] = off;
            elements.push({
              id: `${prefix}-CHJ-${key}-${n + 1}`,
              code: chhajjaCode,
              type: 'chhajja',
              buildingId: bId,
              levelId: 'GF',
              geometry: { shape: 'box', position: cp, size: ax ? [r(cl, 4), r(ct, 4), r(pr, 4)] : [r(pr, 4), r(ct, 4), r(cl, 4)] },
              plannedQuantities: qty(cl * pr * ct, cl * pr + (cl + 2 * pr) * ct, spec.steel.slab),
              notes: `Chhajja ${spec.chhajja.projection} mm projection, ${spec.chhajja.t} mm thick over ${ot.mark}`,
            });
            refs[`${prefix}-CHJ-${key}-${n + 1}`] = { kind: 'chhajja', code: chhajjaCode, row };
            sum.chhajjas++;
          }
        });

        const openArea = openings.reduce((a, o) => a + o.width * o.height, 0);
        const brick = (L * H - openArea) * t - lintelVol;
        const plaster = 2 * (L * H - openArea);
        sum.brickwork += brick;
        sum.plaster += plaster;
        elements.push({
          id: `${prefix}-WAL-${key}`,
          code: `W-${key}`,
          type: 'wall',
          buildingId: bId,
          levelId: 'GF',
          geometry: {
            shape: 'wall',
            position: at(0, H / 2),
            size: ax ? [r(L, 4), r(H, 4), t] : [t, r(H, 4), r(L, 4)],
            ...(openings.length ? { openings } : {}),
          },
          plannedQuantities: { BRICK: { quantity: r(brick, 3), unit: 'm3' }, PLAST: { quantity: r(plaster, 2), unit: 'm2' } },
          notes: `${spec.walls.t} mm wall, ${Math.round(L * 1000)} × ${Math.round(H * 1000)} mm, ${openings.length} opening(s)`,
        });
        refs[`${prefix}-WAL-${key}`] = { kind: 'wall', code: `W-${key}`, wall: key };
        sum.walls++;
      });
    }
  }
  if (errors.length) return fail();

  // ---- slab over the outline of all columns ----
  if (spec.slab.enabled && !boundary) {
    const t = mm(spec.slab.t), ov = mm(spec.slab.overhang);
    const minX = Math.min(...pts.map((p) => xs[p.xi] - mm(p.col.w) / 2)) - ov;
    const maxX = Math.max(...pts.map((p) => xs[p.xi] + mm(p.col.w) / 2)) + ov;
    const minZ = Math.min(...pts.map((p) => zs[p.yi] - mm(p.col.d) / 2)) - ov;
    const maxZ = Math.max(...pts.map((p) => zs[p.yi] + mm(p.col.d) / 2)) + ov;
    const sx = maxX - minX, sz = maxZ - minZ;
    if (pts.length < 3) warnings.push('A roof slab with fewer than 3 columns is unusual — check the layout.');
    if (pts.length < nx * ny) warnings.push('Some grid points have no column; the slab is still drawn over the full outline — check it against the drawing.');
    elements.push({
      id: `${prefix}-SLAB-RF`,
      code: 'SL-RF',
      type: 'slab',
      buildingId: bId,
      levelId: 'RF',
      geometry: { shape: 'box', position: [r((minX + maxX) / 2, 4), r(roof + t / 2, 4), r((minZ + maxZ) / 2, 4)], size: [r(sx, 4), r(t, 4), r(sz, 4)] },
      plannedQuantities: qty(sx * sz * t, sx * sz + 2 * (sx + sz) * t, spec.steel.slab),
      notes: `Roof slab ${spec.slab.t} mm, overhang ${spec.slab.overhang} mm`,
    });
    refs[`${prefix}-SLAB-RF`] = { kind: 'slab' };
    sum.slabs++;
  }

  // ---- elements added by hand on top of the template ----
  const extras = spec.extraElements ?? [];
  if (extras.length) {
    const taken = new Set(elements.map((e) => e.code));
    errors.push(...freeErrors(extras, 'Added element', taken));
    if (errors.length) return fail();
    extras.forEach((f, i) => {
      const id = `${prefix}-X-${f.code.trim().replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
      refs[id] = { kind: 'extra', index: i };
      elements.push(boxElement(f, id, bId, 0, 0, spec.steel, sum));
    });
    warnings.push(`${extras.length} element${extras.length === 1 ? ' was' : 's were'} added by hand — check their position and size against the drawing.`);
  }

  return finishModel(spec, { elements, sum, errors, warnings, refs, bId, foundation: -depth, roof, removed: omit.size });
}

interface Built {
  elements: ModelDocument['elements'];
  sum: BuildSummary;
  errors: string[];
  warnings: string[];
  refs: Record<string, ElementRef>;
  bId: string;
  /** Lowest and highest level (m): footing bottom (negative) and roof. */
  foundation: number;
  roof: number;
  /** Elements removed by hand (spec.omit). */
  removed: number;
}

/** Steel notes, typed-in quantities, totals and the model document — the same for every kind. */
function finishModel(spec: BuilderSpec, b: Built): BuildResult {
  const { elements, sum, errors, warnings, refs, bId } = b;
  const fail = (): BuildResult => ({ errors, warnings, document: null, summary: null, refs: {}, auto: {} });
  if (Object.values(spec.steel).some((v) => v > 0)) warnings.push('Reinforcement (kg) is estimated from kg/m³ rates — replace with the bar bending schedule (BBS) quantities when available.');
  if (Object.values(spec.steel).some((v) => v === 0)) warnings.push('Element types with steel rate 0 have no reinforcement quantity (shown as "Not configured").');

  const document: ModelDocument = {
    format: 'pmc-procedural-model',
    formatVersion: 1,
    project: { id: spec.projectId.trim(), name: spec.projectName.trim(), ...(spec.location?.trim() ? { location: spec.location.trim() } : {}) },
    model: {
      id: spec.modelId.trim(),
      name: spec.modelName.trim() || `${spec.buildingName.trim()} — Structure`,
      revision: spec.revision.trim(),
      lengthUnit: 'm',
      upAxis: 'y',
      source: {
        type: 'model-builder',
        builderSpec: spec,
        drawings: spec.drawingRefs,
        kind: kindOf(spec),
        grid: { xSpansMm: spec.xSpans, ySpansMm: spec.ySpans },
        columnSchedule: spec.columnTypes,
        footingSchedule: spec.footingTypes,
        openingSchedule: spec.openingTypes,
        steelRatesKgPerM3: spec.steel,
        materialNorms: withNormDefaults(spec.materialNorms),
        note: 'Built in the Model Builder from values read off the drawing(s). Verify against the approved drawing.',
      },
    },
    buildings: [{ id: bId, name: spec.buildingName.trim() }],
    levels: [
      { id: 'FDN', name: 'Foundation', buildingId: bId, elevation: r(b.foundation, 3) },
      { id: 'GF', name: 'Ground / Plinth', buildingId: bId, elevation: 0 },
      { id: 'RF', name: kindOf(spec) === 'boundary' ? 'Top of wall' : 'Roof', buildingId: bId, elevation: r(b.roof, 3) },
    ],
    activities: ACTIVITIES.map((a) => ({ ...a, appliesTo: [...a.appliesTo] })),
    elements,
  } as ModelDocument;

  // ---- planned quantities typed in by hand replace the calculated ones ----
  const auto: Record<string, Record<string, number>> = {};
  let typed = 0;
  for (const e of elements) {
    auto[e.id] = Object.fromEntries(Object.entries(e.plannedQuantities).map(([k, q]) => [k, q.quantity]));
    const over = spec.qtyOverride?.[e.code];
    if (!over) continue;
    for (const [act, value] of Object.entries(over)) {
      const def = ACTIVITIES.find((a) => a.code === act);
      if (!def || !def.appliesTo.includes(e.type)) continue; // stale entry after a change of the model
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push(`${e.code}: planned ${def.name} must be a number of 0 or more (${def.unit}), or set back to Auto.`);
        continue;
      }
      const before = e.plannedQuantities[act]?.quantity ?? 0;
      e.plannedQuantities[act] = { quantity: value, unit: def.unit };
      const key = SUMMARY_KEY[act];
      if (key) sum[key] += value - before;
      typed++;
    }
  }
  const norms = withNormDefaults(spec.materialNorms);
  errors.push(...normErrors(norms));
  if (errors.length) return fail();
  sum.materials = elements.reduce((acc, e) => addMaterials(acc, materialsFor(Object.fromEntries(Object.entries(e.plannedQuantities).map(([k, q]) => [k, q.quantity])), norms)), emptyMaterials());
  if (typed) warnings.push(`${typed} planned quantit${typed === 1 ? 'y was' : 'ies were'} entered by hand instead of calculated — check against the drawing / BOQ.`);

  sum.concrete = r(sum.concrete, 3);
  sum.shuttering = r(sum.shuttering, 2);
  sum.steel = r(sum.steel, 1);
  sum.brickwork = r(sum.brickwork, 3);
  sum.plaster = r(sum.plaster, 2);
  if (b.removed) warnings.push(`${b.removed} element${b.removed === 1 ? ' was' : 's were'} removed by hand in the 3D preview (beams / walls / lintels / chhajjas) — check against the drawing.`);
  return { errors, warnings, document, summary: sum, refs, auto };
}

const emptySummary = (): BuildSummary => ({
  footings: 0,
  columns: 0,
  beams: 0,
  slabs: 0,
  walls: 0,
  doors: 0,
  windows: 0,
  lintels: 0,
  chhajjas: 0,
  concrete: 0,
  shuttering: 0,
  steel: 0,
  brickwork: 0,
  plaster: 0,
});

const STEEL_OF: Partial<Record<ElementType, keyof SteelRates>> = {
  footing: 'footing',
  column: 'column',
  beam: 'beam',
  lintel: 'beam',
  slab: 'slab',
  chhajja: 'slab',
};
const COUNT_OF: Record<ElementType, keyof BuildSummary> = {
  footing: 'footings',
  column: 'columns',
  beam: 'beams',
  slab: 'slabs',
  wall: 'walls',
  door: 'doors',
  window: 'windows',
  lintel: 'lintels',
  chhajja: 'chhajjas',
};

/** Problems of a list of box elements (free model or extras), in plain words. */
function freeErrors(list: FreeElement[], what: string, taken: Set<string> = new Set()): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((f, i) => {
    const code = (f.code ?? '').trim();
    const label = `${what} row ${i + 1}${code ? ` (${code})` : ''}`;
    if (!code) errors.push(`${label}: code is required, e.g. F1, C1, W-FRONT.`);
    else if (seen.has(code) || taken.has(code)) errors.push(`Element code "${code}" is used twice — every element needs its own code.`);
    seen.add(code);
    if (!ELEMENT_TYPES.includes(f.type)) errors.push(`${label}: choose its type.`);
    if (![f.x, f.y, f.z].every((n) => typeof n === 'number' && Number.isFinite(n))) errors.push(`${label}: position X, Y and bottom level must be numbers (mm).`);
    if (!pos(f.l) || !pos(f.w) || !pos(f.h)) errors.push(`${label}: length, width and height must be positive (mm).`);
  });
  return errors;
}

/** One element from a box (mm), centred on (cx, cy), with quantities from the box itself. */
function boxElement(f: FreeElement, id: string, bId: string, cx: number, cy: number, steel: SteelRates, sum: BuildSummary): ModelDocument['elements'][number] {
  const L = mm(f.l), W = mm(f.w), H = mm(f.h);
  const position: [number, number, number] = [r(mm(f.x - cx), 4), r(mm(f.z) + H / 2, 4), r(-mm(f.y - cy), 4) + 0];
  const size: [number, number, number] = [r(L, 4), r(H, 4), r(W, 4)];
  const q: Record<string, { quantity: number; unit: 'kg' | 'm2' | 'm3' | 'nos' }> = {};
  const rate = STEEL_OF[f.type];
  if (rate) {
    const conc = L * W * H;
    const long = Math.max(L, W), short = Math.min(L, W);
    const shut =
      f.type === 'footing' || f.type === 'column' ? 2 * (L + W) * H : f.type === 'beam' || f.type === 'lintel' ? (2 * H + short) * long : L * W + 2 * (L + W) * H;
    q.SHUT = { quantity: r(shut, 2), unit: 'm2' };
    q.CONC = { quantity: r(conc, 3), unit: 'm3' };
    sum.concrete += conc;
    sum.shuttering += shut;
    if (steel[rate] > 0) {
      q.REINF = { quantity: r(conc * steel[rate], 1), unit: 'kg' };
      sum.steel += conc * steel[rate];
    }
  } else if (f.type === 'wall') {
    const brick = L * W * H, plaster = 2 * Math.max(L, W) * H;
    q.BRICK = { quantity: r(brick, 3), unit: 'm3' };
    q.PLAST = { quantity: r(plaster, 2), unit: 'm2' };
    sum.brickwork += brick;
    sum.plaster += plaster;
  } else {
    q.FIX = { quantity: 1, unit: 'nos' };
  }
  sum[COUNT_OF[f.type]]++;
  return {
    id,
    code: f.code.trim(),
    type: f.type,
    buildingId: bId,
    levelId: f.type === 'footing' ? 'FDN' : f.type === 'slab' ? 'RF' : 'GF',
    geometry: { shape: f.type === 'wall' ? 'wall' : 'box', position, size },
    plannedQuantities: q,
    notes: `${f.type[0].toUpperCase()}${f.type.slice(1)} ${f.l} × ${f.w} × ${f.h} mm, bottom at ${f.z} mm`,
  };
}

/** A starting size (mm) for an element added by hand, by type: what a small RCC building usually has. */
export const NEW_ELEMENT: Record<ElementType, Omit<FreeElement, 'code' | 'type' | 'x' | 'y'>> = {
  footing: { z: -1000, l: 1200, w: 1200, h: 300 },
  column: { z: -700, l: 300, w: 300, h: 3700 },
  beam: { z: 2700, l: 3000, w: 230, h: 300 },
  slab: { z: 3000, l: 3000, w: 3000, h: 125 },
  wall: { z: 0, l: 3000, w: 230, h: 2700 },
  lintel: { z: 2100, l: 1500, w: 230, h: 150 },
  chhajja: { z: 2250, l: 1500, w: 450, h: 75 },
  door: { z: 0, l: 900, w: 40, h: 2100 },
  window: { z: 900, l: 1200, w: 40, h: 1200 },
};

/** A free model: every element as listed, quantities from its own box. */
function buildFree(spec: BuilderSpec, errors: string[], warnings: string[]): BuildResult {
  const fail = (): BuildResult => ({ errors, warnings, document: null, summary: null, refs: {}, auto: {} });
  const list = spec.freeElements ?? [];
  if (!list.length) errors.push('Add at least one element to the free model (section 2), or choose another structure type.');
  errors.push(...freeErrors(list, 'Element'));
  (['footing', 'column', 'beam', 'slab'] as const).forEach((k) => {
    if (!(spec.steel[k] >= 0)) errors.push(`Steel rate for ${k} must be 0 or more (kg/m³).`);
  });
  if (errors.length) return fail();

  const prefix = spec.modelId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'MDL';
  const bId = `BLD-${prefix}`;
  // centre the plan on 0, like the grid templates
  const cx = (Math.min(...list.map((f) => f.x - f.l / 2)) + Math.max(...list.map((f) => f.x + f.l / 2))) / 2;
  const cy = (Math.min(...list.map((f) => f.y - f.w / 2)) + Math.max(...list.map((f) => f.y + f.w / 2))) / 2;
  const sum = emptySummary();
  const refs: Record<string, ElementRef> = {};
  const ids = new Set<string>();
  const elements: ModelDocument['elements'] = list.map((f, i) => {
    const code = f.code.trim();
    let id = `${prefix}-E-${code.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    refs[id] = { kind: 'free', index: i };
    return boxElement(f, id, bId, cx, cy, spec.steel, sum);
  });
  warnings.push('Free model: every element is as listed — check positions and sizes against the drawing.');
  const bottoms = list.map((f) => mm(f.z));
  const tops = list.map((f) => mm(f.z + f.h));
  return finishModel(spec, {
    elements,
    sum,
    errors,
    warnings,
    refs,
    bId,
    foundation: Math.min(-0.001, ...bottoms),
    roof: Math.max(0.001, ...tops),
    removed: 0,
  });
}

/** A model's elements as a free model (to change anything the templates cannot). Walls lose their cut-outs. */
export function toFreeElements(doc: ModelDocument): FreeElement[] {
  const n = (m: number) => Math.round(m * 1000) + 0;
  return doc.elements.map((e) => ({
    code: e.code,
    type: e.type,
    x: n(e.geometry.position[0]),
    y: n(-e.geometry.position[2]),
    z: n(e.geometry.position[1] - e.geometry.size[1] / 2),
    l: n(e.geometry.size[0]),
    w: n(e.geometry.size[2]),
    h: n(e.geometry.size[1]),
  }));
}


/**
 * The spec without the clicked element. Columns go with their footing (the grid point is
 * cleared); a wall goes with the doors / windows in it; the others are listed in spec.omit.
 */
export function removeElement(spec: BuilderSpec, ref: ElementRef): BuilderSpec {
  const omitWith = (...codes: string[]) => ({ ...spec, omit: [...new Set([...(spec.omit ?? []), ...codes])] });
  switch (ref.kind) {
    case 'column':
    case 'footing': {
      // the walls ending at this point change, so the doors / windows placed in them go too
      const point = `${gridLabel('X', ref.xi)}${gridLabel('Y', ref.yi)}`;
      return {
        ...spec,
        layout: spec.layout.map((row, y) => (y === ref.yi ? row.map((c, x) => (x === ref.xi ? '' : c)) : row)),
        openings: spec.openings.filter((o) => !o.wall.split('-').includes(point)),
      };
    }
    case 'opening':
      return { ...spec, openings: spec.openings.filter((_, i) => i !== ref.row) };
    case 'wall':
      return { ...omitWith(ref.code), openings: spec.openings.filter((o) => o.wall !== ref.wall) };
    case 'slab':
      return { ...spec, slab: { ...spec.slab, enabled: false } };
    case 'free':
      return { ...spec, freeElements: (spec.freeElements ?? []).filter((_, i) => i !== ref.index) };
    case 'extra':
      return { ...spec, extraElements: (spec.extraElements ?? []).filter((_, i) => i !== ref.index) };
    default:
      return omitWith(ref.code);
  }
}

/**
 * Defaults: a single-bay security cabin like the "Typical Drawing of Security Cabin"
 * (3000 × 3000 inside). Walls are off; when switched on, the drawing's 230 mm walls, door D,
 * windows W, ventilator V, lintels and chhajjas are pre-filled.
 */
export function defaultSpec(): BuilderSpec {
  return {
    projectId: 'PMC-SEC-003',
    projectName: 'Security Cabin',
    location: '',
    modelId: 'SEC-CABIN',
    modelName: '',
    revision: 'R01',
    buildingName: 'Security Cabin',
    xSpans: [3230],
    ySpans: [3230],
    columnTypes: [{ code: 'C1', w: 300, d: 300, footing: 'F1' }],
    footingTypes: [{ code: 'F1', w: 1400, d: 1400, t: 300 }],
    layout: makeLayout(2, 2, 'C1'),
    foundationDepth: 1000,
    roofLevel: 3000,
    plinthBeam: { enabled: true, w: 230, h: 300 },
    roofBeam: { enabled: true, w: 230, h: 300 },
    slab: { enabled: true, t: 125, overhang: 450 },
    steel: { footing: 80, column: 180, beam: 150, slab: 90 },
    // Off by default: the model is the structural frame only. Ticking "Brick walls" adds walls,
    // and the door / window schedule and placements below (from the typical drawing) apply.
    walls: { enabled: false, t: 230, internal: false },
    openingTypes: [
      { mark: 'D', kind: 'door', w: 900, h: 2100, sill: 0 },
      { mark: 'D1', kind: 'door', w: 750, h: 2100, sill: 0 },
      { mark: 'W', kind: 'window', w: 1500, h: 1200, sill: 900 },
      { mark: 'V', kind: 'ventilator', w: 600, h: 450, sill: 1800 },
    ],
    openings: [
      { mark: 'D', wall: 'X1Y1-X2Y1', offset: null },
      { mark: 'W', wall: 'X1Y1-X1Y2', offset: null },
      { mark: 'W', wall: 'X2Y1-X2Y2', offset: null },
      { mark: 'V', wall: 'X1Y2-X2Y2', offset: null },
    ],
    lintel: { enabled: true, h: 150, bearing: 150 },
    chhajja: { enabled: true, projection: 450, t: 75, overDoors: true },
    drawingRefs: [],
  };
}

/** A new project: the default frame, but no project / model names, so nothing old is reused. */
export function blankSpec(): BuilderSpec {
  return { ...defaultSpec(), projectId: '', projectName: '', modelId: '', modelName: '', buildingName: '', location: '', revision: 'R01' };
}

/**
 * Fill fields that older saved specs (from before walls / openings existed) do not have.
 * Walls stay off; the default door / window placements that exist on its grid are pre-filled
 * for when the user switches walls on.
 */
export function withDefaults(spec: Partial<BuilderSpec>): BuilderSpec {
  const d = defaultSpec();
  const merged: BuilderSpec = {
    ...d,
    ...spec,
    walls: { ...d.walls, ...spec.walls },
    lintel: { ...d.lintel, ...spec.lintel },
    chhajja: { ...d.chhajja, ...spec.chhajja },
    openingTypes: spec.openingTypes ?? d.openingTypes,
    openings: spec.openings ?? [],
  };
  if (spec.openings === undefined) {
    const keys = new Set(wallOptions(merged).map((w) => w.key));
    merged.openings = d.openings.filter((o) => keys.has(o.wall));
  }
  return merged;
}

/** Walls the current grid / layout would generate, for the opening placement dropdown. */
export function wallOptions(spec: BuilderSpec): { key: string; label: string }[] {
  const nx = spec.xSpans.length + 1;
  const ny = spec.ySpans.length + 1;
  const has = (xi: number, yi: number) => !!(spec.layout[yi]?.[xi] ?? '').trim();
  const omitted = new Set(spec.omit ?? []);
  const boundary = kindOf(spec) === 'boundary';
  const internal = spec.walls.internal && !boundary;
  const out: { key: string; label: string }[] = [];
  for (let yi = 0; yi < ny; yi++) {
    if (!internal && yi !== 0 && yi !== ny - 1) continue;
    const row = Array.from({ length: nx }, (_, xi) => xi).filter((xi) => has(xi, yi));
    row.slice(0, -1).forEach((xi, i) => {
      if (boundary && row[i + 1] - xi !== 1) return;
      const key = `${gridLabel('X', xi)}${gridLabel('Y', yi)}-${gridLabel('X', row[i + 1])}${gridLabel('Y', yi)}`;
      out.push({ key, label: `${key} · along X on line ${gridLabel('Y', yi)}` });
    });
  }
  for (let xi = 0; xi < nx; xi++) {
    if (!internal && xi !== 0 && xi !== nx - 1) continue;
    const line = Array.from({ length: ny }, (_, yi) => yi).filter((yi) => has(xi, yi));
    line.slice(0, -1).forEach((yi, i) => {
      if (boundary && line[i + 1] - yi !== 1) return;
      const key = `${gridLabel('X', xi)}${gridLabel('Y', yi)}-${gridLabel('X', xi)}${gridLabel('Y', line[i + 1])}`;
      out.push({ key, label: `${key} · along Y on line ${gridLabel('X', xi)}` });
    });
  }
  return out.filter((w) => !omitted.has(`W-${w.key}`));
}

/**
 * Where an opening can sit on its wall, in mm measured from the wall's first grid point (the
 * same unit as OpeningPlacement.offset): its centred position and the allowed min / max so the
 * opening stays between the two column faces. null when the wall, columns or mark are unknown.
 */
export function openingRange(spec: BuilderSpec, placement: Pick<OpeningPlacement, 'mark' | 'wall'>) {
  const m = /^X(\d+)Y(\d+)-X(\d+)Y(\d+)$/.exec(placement.wall);
  const ot = spec.openingTypes.find((o) => o.mark.trim() === placement.mark.trim());
  if (!m || !ot || !(ot.w > 0)) return null;
  const [ax, ay, bx, by] = m.slice(1).map((n) => Number(n) - 1);
  const alongX = ay === by;
  if (alongX === (ax === bx)) return null;
  const spans = alongX ? spec.xSpans : spec.ySpans;
  const [i0, i1] = alongX ? [ax, bx] : [ay, by];
  if (i1 <= i0 || i1 > spans.length) return null;
  const dist = spans.slice(i0, i1).reduce((a, b) => a + b, 0);
  const col = (xi: number, yi: number) => spec.columnTypes.find((c) => c.code.trim() === (spec.layout[yi]?.[xi] ?? '').trim());
  const ca = col(ax, ay);
  const cb = col(bx, by);
  if (!ca || !cb) return null;
  const halfA = (alongX ? ca.w : ca.d) / 2;
  const halfB = (alongX ? cb.w : cb.d) / 2;
  const min = Math.ceil(halfA + ot.w / 2);
  const max = Math.floor(dist - halfB - ot.w / 2);
  return { centre: Math.round((halfA + dist - halfB) / 2), min, max, fits: max >= min };
}

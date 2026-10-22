// Model Builder: turns the values an engineer reads off a PDF / image drawing (grid, column and
// footing schedules, beam and slab sizes, levels, walls, door/window schedule) into a
// pmc-procedural-model v1 document. The result goes through the normal import pipeline
// (validation, revisions, register), so a built model behaves exactly like an imported JSON file.
//
// Inputs are in millimetres, like the drawings. Output geometry is in metres, Y up, ground = 0.
// Quantities: concrete (m3) and shuttering (m2) come from the geometry; reinforcement (kg) uses
// the kg-per-m3 rate entered for each element type until a bar bending schedule (BBS) is available.
// Brickwork (m3) and plaster (m2) are net of openings (and lintels for brickwork).

import type { ElementType, ModelDocument, WallOpening } from './types';

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

export interface BuilderSpec {
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
}

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
}

export interface BuildResult {
  errors: string[];
  warnings: string[];
  document: ModelDocument | null;
  summary: BuildSummary | null;
}

const RCC_TYPES: ElementType[] = ['footing', 'column', 'beam', 'slab', 'lintel', 'chhajja'];

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

/** Parse "3230, 2115" or "3230 2115" into numbers (mm). Returns null if any part is not a positive number. */
export function parseSpans(text: string): number[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = parts.map(Number);
  return nums.length && nums.every(pos) ? nums : null;
}

export function buildModel(spec: BuilderSpec): BuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): BuildResult => ({ errors, warnings, document: null, summary: null });

  // ---- header ----
  if (!spec.projectId.trim() || !ID_RE.test(spec.projectId.trim())) errors.push('Project ID is required (letters, digits, - _ . only), e.g. PMC-SEC-003.');
  if (!spec.projectName.trim()) errors.push('Project name is required.');
  if (!spec.modelId.trim() || !ID_RE.test(spec.modelId.trim())) errors.push('Model ID is required (letters, digits, - _ . only), e.g. SEC-CABIN-D85.');
  if (!spec.revision.trim()) errors.push('Revision is required, e.g. R01.');
  if (!spec.buildingName.trim()) errors.push('Building name is required.');

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
    sum.columns++;
  });

  // ---- spans between consecutive columns along every grid line ----
  type Span = { a: Pt; b: Pt; axis: 'x' | 'z' };
  const spans: Span[] = [];
  for (let yi = 0; yi < ny; yi++) {
    const row = pts.filter((p) => p.yi === yi).sort((a, b) => a.xi - b.xi);
    row.slice(0, -1).forEach((a, i) => spans.push({ a, b: row[i + 1], axis: 'x' }));
  }
  for (let xi = 0; xi < nx; xi++) {
    const line = pts.filter((p) => p.xi === xi).sort((a, b) => a.yi - b.yi);
    line.slice(0, -1).forEach((a, i) => spans.push({ a, b: line[i + 1], axis: 'z' }));
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
      const { len, mid } = clearSpan(s);
      if (len <= 0) {
        warnings.push(`${label} ${s.a.key}–${s.b.key}: columns touch, no beam generated.`);
        return;
      }
      elements.push({
        id: `${prefix}-${tag}-${spanKey(s)}`,
        code: `${tag}-${spanKey(s)}`,
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
      sum.beams++;
    });
  };
  addBeams('PB', 'GF', 0, spec.plinthBeam, 'Plinth beam');
  addBeams('RB', 'RF', roof, spec.roofBeam, 'Roof beam');
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

    const wallSpans = spans.filter((s) => spec.walls.internal || isOuter(s));
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
          if (isDoor) sum.doors++;
          else sum.windows++;

          // RCC lintel over the opening
          const top = sill + h;
          let lintelTop = top;
          const bearing = mm(spec.lintel.bearing);
          if (spec.lintel.enabled) {
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
                code: `L-${ot.mark}-${key}`,
                type: 'lintel',
                buildingId: bId,
                levelId: 'GF',
                geometry: { shape: 'box', position: at((lo + hi) / 2, top + lh / 2), size: ax ? [r(ll, 4), r(lh, 4), lt] : [lt, r(lh, 4), r(ll, 4)] },
                plannedQuantities: qty(ll * t * lh, 2 * lh * ll + t * w, spec.steel.beam),
                notes: `RCC lintel ${Math.round(ll * 1000)} × ${spec.walls.t} × ${spec.lintel.h} mm over ${ot.mark}`,
              });
              lintelVol += ll * t * lh;
              lintelTop = top + lh;
              sum.lintels++;
            }
          }

          // chhajja outside, over windows (and doors if chosen), on outer walls only
          if (spec.chhajja.enabled && isOuter(s) && outSign !== 0 && (!isDoor || spec.chhajja.overDoors)) {
            const pr = mm(spec.chhajja.projection), ct = mm(spec.chhajja.t);
            const cl = Math.min(w + 2 * bearing, L);
            const cc = Math.max(Math.min(c, L / 2 - cl / 2), -L / 2 + cl / 2);
            const cp = at(cc, lintelTop - ct / 2);
            const off = r(line + outSign * (t / 2 + pr / 2), 4);
            if (ax) cp[2] = off;
            else cp[0] = off;
            elements.push({
              id: `${prefix}-CHJ-${key}-${n + 1}`,
              code: `CH-${ot.mark}-${key}`,
              type: 'chhajja',
              buildingId: bId,
              levelId: 'GF',
              geometry: { shape: 'box', position: cp, size: ax ? [r(cl, 4), r(ct, 4), r(pr, 4)] : [r(pr, 4), r(ct, 4), r(cl, 4)] },
              plannedQuantities: qty(cl * pr * ct, cl * pr + (cl + 2 * pr) * ct, spec.steel.slab),
              notes: `Chhajja ${spec.chhajja.projection} mm projection, ${spec.chhajja.t} mm thick over ${ot.mark}`,
            });
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
        sum.walls++;
      });
    }
  }
  if (errors.length) return fail();

  // ---- slab over the outline of all columns ----
  if (spec.slab.enabled) {
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
    sum.slabs++;
  }

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
        grid: { xSpansMm: spec.xSpans, ySpansMm: spec.ySpans },
        columnSchedule: spec.columnTypes,
        footingSchedule: spec.footingTypes,
        openingSchedule: spec.openingTypes,
        steelRatesKgPerM3: spec.steel,
        note: 'Built in the Model Builder from values read off the drawing(s). Verify against the approved drawing.',
      },
    },
    buildings: [{ id: bId, name: spec.buildingName.trim() }],
    levels: [
      { id: 'FDN', name: 'Foundation', buildingId: bId, elevation: r(-depth, 3) },
      { id: 'GF', name: 'Ground / Plinth', buildingId: bId, elevation: 0 },
      { id: 'RF', name: 'Roof', buildingId: bId, elevation: r(roof, 3) },
    ],
    activities: [
      { code: 'REINF', name: 'Reinforcement', unit: 'kg', appliesTo: RCC_TYPES },
      { code: 'SHUT', name: 'Shuttering', unit: 'm2', appliesTo: RCC_TYPES },
      { code: 'CONC', name: 'Concreting', unit: 'm3', appliesTo: RCC_TYPES },
      { code: 'BRICK', name: 'Brickwork', unit: 'm3', appliesTo: ['wall'] },
      { code: 'PLAST', name: 'Plaster', unit: 'm2', appliesTo: ['wall'] },
      { code: 'FIX', name: 'Fixing', unit: 'nos', appliesTo: ['door', 'window'] },
    ],
    elements,
  } as ModelDocument;

  sum.concrete = r(sum.concrete, 3);
  sum.shuttering = r(sum.shuttering, 2);
  sum.steel = r(sum.steel, 1);
  sum.brickwork = r(sum.brickwork, 3);
  sum.plaster = r(sum.plaster, 2);
  return { errors, warnings, document, summary: sum };
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
  const out: { key: string; label: string }[] = [];
  for (let yi = 0; yi < ny; yi++) {
    if (!spec.walls.internal && yi !== 0 && yi !== ny - 1) continue;
    const row = Array.from({ length: nx }, (_, xi) => xi).filter((xi) => has(xi, yi));
    row.slice(0, -1).forEach((xi, i) => {
      const key = `${gridLabel('X', xi)}${gridLabel('Y', yi)}-${gridLabel('X', row[i + 1])}${gridLabel('Y', yi)}`;
      out.push({ key, label: `${key} · along X on line ${gridLabel('Y', yi)}` });
    });
  }
  for (let xi = 0; xi < nx; xi++) {
    if (!spec.walls.internal && xi !== 0 && xi !== nx - 1) continue;
    const line = Array.from({ length: ny }, (_, yi) => yi).filter((yi) => has(xi, yi));
    line.slice(0, -1).forEach((yi, i) => {
      const key = `${gridLabel('X', xi)}${gridLabel('Y', yi)}-${gridLabel('X', xi)}${gridLabel('Y', line[i + 1])}`;
      out.push({ key, label: `${key} · along Y on line ${gridLabel('X', xi)}` });
    });
  }
  return out;
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

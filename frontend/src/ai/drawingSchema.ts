// What the AI returns after reading a drawing, and how it becomes a Model Builder spec.
// Kept free of browser / SDK code so it can be unit-tested.

import * as z from 'zod/v4';
import { defaultSpec, gridLabel, makeLayout, type BuilderSpec, type OpeningPlacement, type StructureKind } from '../domain/modelBuilder';
import { ELEMENT_TYPES } from '../domain/types';

const presentSize = z.object({ present: z.boolean(), widthMm: z.number(), depthMm: z.number() });
const roomSchema = z.object({
  name: z.string(),
  kind: z
    .enum(['room', 'open', 'balcony', 'terrace'])
    .describe('room = walls all round; open = under the roof without its own walls (parking, porch, verandah); balcony = projecting balcony on an upper floor; terrace = open to the sky.'),
  xMm: z.number().describe("Front-left corner from the building's front-left corner, along X, mm."),
  yMm: z.number().describe("Front-left corner from the building's front-left corner, along Y (front to back), mm."),
  widthMm: z.number().describe('Along X, mm.'),
  depthMm: z.number().describe('Along Y, mm.'),
});
const roomOpeningSchema = z.object({
  type: z.enum(['door', 'window']),
  xMm: z.number().describe('Centre on the plan, same origin as the rooms, mm.'),
  yMm: z.number(),
  widthMm: z.number(),
  heightMm: z.number(),
  sillMm: z.number().describe('0 for doors.'),
  between: z.array(z.string()).describe('The two spaces this opening joins, by their names in rooms, or "outside" — e.g. ["Drawing room", "Porch"], ["Bed room", "outside"].'),
});

export const DrawingReadingSchema = z.object({
  structureKind: z
    .enum(['building', 'boundary-wall', 'other'])
    .describe('building = rooms on a column grid with a roof slab; boundary-wall = compound / boundary wall (piers on a line or around a plot, no roof); other = anything else, listed in "elements".'),
  projectName: z.string().describe('Project / building name as written on the drawing title block, e.g. "Security Cabin".'),
  buildingName: z.string(),
  xSpansMm: z.array(z.number()).describe('Centre-to-centre spacing between consecutive vertical grid lines, left to right, in mm.'),
  ySpansMm: z.array(z.number()).describe('Centre-to-centre spacing between consecutive horizontal grid lines, bottom (front) to top, in mm.'),
  columnTypes: z.array(z.object({ code: z.string(), widthMm: z.number(), depthMm: z.number(), footingCode: z.string() })),
  footingTypes: z.array(z.object({ code: z.string(), lengthMm: z.number(), widthMm: z.number(), depthMm: z.number() })),
  columns: z
    .array(z.object({ grid: z.string().describe('Grid point like "X1Y1" (X from left, Y from bottom/front).'), columnCode: z.string() }))
    .describe('Every column position.'),
  foundationDepthMm: z.number().describe('Bottom of footing below ground / plinth level, mm (positive number).'),
  roofLevelMm: z.number().describe('Top of roof beams = bottom of roof slab, above ground / plinth level, mm.'),
  plinthBeam: presentSize,
  roofBeam: presentSize,
  slab: z.object({ present: z.boolean(), thicknessMm: z.number(), overhangMm: z.number() }),
  walls: z.object({ present: z.boolean(), thicknessMm: z.number(), alsoOnInternalGridLines: z.boolean() }),
  openingTypes: z.array(
    z.object({
      mark: z.string(),
      kind: z.enum(['door', 'window', 'ventilator']),
      widthMm: z.number(),
      heightMm: z.number(),
      sillMm: z.number().describe('Height of the opening bottom above floor; 0 for doors.'),
    }),
  ),
  openings: z
    .array(
      z.object({
        mark: z.string(),
        fromGrid: z.string().describe('Grid point at one end of the wall the opening is in, e.g. "X1Y1".'),
        toGrid: z.string().describe('Grid point at the other end of that wall, on the same grid line, e.g. "X2Y1".'),
        centreFromStartMm: z.number().nullable().describe('Distance from fromGrid to the opening centre along the wall, mm; null if centred.'),
      }),
    )
    .describe('Every door / window / ventilator placed in a wall.'),
  lintel: z.object({ present: z.boolean(), depthMm: z.number() }),
  chhajja: z.object({ present: z.boolean(), projectionMm: z.number(), thicknessMm: z.number() }),
  elements: z
    .array(
      z.object({
        code: z.string(),
        type: z.enum(ELEMENT_TYPES),
        xMm: z.number().describe('Centre on the plan, from the left edge, mm.'),
        yMm: z.number().describe('Centre on the plan, from the front (bottom) edge, mm.'),
        bottomMm: z.number().describe('Level of the underside; 0 = ground, negative below ground, mm.'),
        lengthMm: z.number().describe('Size along X, mm.'),
        widthMm: z.number().describe('Size along Y, mm.'),
        heightMm: z.number(),
      }),
    )
    .describe('Only when structureKind is "other": every element as a box. Empty otherwise.'),
  rooms: z
    .array(roomSchema)
    .describe('For structureKind "building": every room / space as a rectangle covering the whole plan. Empty otherwise.'),
  roomOpenings: z
    .array(roomOpeningSchema)
    .describe('For structureKind "building": every door and window, centred on the wall line it is in. Empty otherwise.'),
  upperFloors: z
    .array(
      z.object({
        name: z.string().describe('e.g. "First floor".'),
        floorToFloorMm: z.number().describe('From the roof level of the floor below to this floor\'s roof level, mm.'),
        rooms: z.array(roomSchema),
        roomOpenings: z.array(roomOpeningSchema),
      }),
    )
    .describe('For structureKind "building": every floor above the ground floor, bottom to top, same origin as the ground-floor rooms. Empty for one storey.'),
  parapet: z.object({ present: z.boolean(), heightMm: z.number(), thicknessMm: z.number() }),
  mumty: z.object({ present: z.boolean(), heightMm: z.number() }).describe('Stair cabin on the roof over the top-floor stair.'),
  assumptions: z.array(z.string()).describe('Every value NOT written on the drawing that you assumed, and why. Empty if none.'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export type DrawingReading = z.infer<typeof DrawingReadingSchema>;

const GRID_RE = /^X(\d+)Y(\d+)$/i;
export const parseGrid = (g: string) => {
  const m = GRID_RE.exec(g.trim().replace(/[\s/-]/g, ''));
  return m ? { xi: Number(m[1]) - 1, yi: Number(m[2]) - 1 } : null;
};

/**
 * Turn the AI reading into a Model Builder spec. Header fields (project id, model id, revision)
 * and steel rates come from the current form, not from the AI. Returns notes for anything that
 * had to be adjusted, so the user can see it next to the AI's own assumptions.
 */
/** An answer from an older server (before structure types) is a building with no free elements. */
export function withReadingDefaults(raw: unknown): unknown {
  return raw && typeof raw === 'object' ? { structureKind: 'building', elements: [], rooms: [], roomOpenings: [], upperFloors: [], parapet: { present: false, heightMm: 0, thicknessMm: 0 }, mumty: { present: true, heightMm: 0 }, ...(raw as object) } : raw;
}

type ReadRoom = z.infer<typeof roomSchema>;
type ReadOpening = z.infer<typeof roomOpeningSchema>;
const toRoom = (rm: ReadRoom) => ({
  name: rm.name.trim(),
  ...(rm.kind && rm.kind !== 'room' ? { kind: rm.kind } : {}),
  x: Math.round(rm.xMm),
  y: Math.round(rm.yMm),
  w: Math.round(rm.widthMm),
  d: Math.round(rm.depthMm),
});
const toRoomOpening = (o: ReadOpening) => ({
  type: o.type,
  x: Math.round(o.xMm),
  y: Math.round(o.yMm),
  width: Math.round(o.widthMm),
  height: Math.round(o.heightMm),
  sill: o.type === 'door' ? 0 : Math.max(Math.round(o.sillMm), 0),
  ...(o.between?.[0]?.trim() ? { between: [o.between[0].trim(), o.between[1]?.trim() || 'outside'] as [string, string] } : {}),
});

export function readingToSpec(r: DrawingReading, base: BuilderSpec): { spec: BuilderSpec; notes: string[] } {
  const notes: string[] = [];
  // a building read as rooms is built from the rooms (walls exactly on the room edges)
  const kind: StructureKind =
    r.structureKind === 'boundary-wall' ? 'boundary' : r.structureKind === 'other' ? 'free' : r.rooms.length ? 'rooms' : 'building';
  const d = defaultSpec();
  const pos = (n: number) => Number.isFinite(n) && n > 0;
  const xSpans = r.xSpansMm.filter(pos);
  const ySpans = r.ySpansMm.filter(pos);
  if (xSpans.length !== r.xSpansMm.length || ySpans.length !== r.ySpansMm.length) notes.push('Some grid spacings were not positive and were dropped.');
  const nx = xSpans.length + 1;
  const ny = ySpans.length + 1;

  const layout = makeLayout(nx, ny, '');
  for (const c of r.columns) {
    const g = parseGrid(c.grid);
    if (!g || g.xi < 0 || g.yi < 0 || g.xi >= nx || g.yi >= ny) {
      notes.push(`Column "${c.columnCode}" at "${c.grid}" is outside the ${nx} × ${ny} grid and was skipped.`);
      continue;
    }
    layout[g.yi][g.xi] = c.columnCode.trim();
  }

  // An opening's wall may span several column bays; place it in the bay that contains its centre.
  const xs = [0, ...xSpans.map((_, i) => xSpans.slice(0, i + 1).reduce((a, b) => a + b, 0))];
  const ys = [0, ...ySpans.map((_, i) => ySpans.slice(0, i + 1).reduce((a, b) => a + b, 0))];
  const openings: OpeningPlacement[] = [];
  for (const o of r.openings) {
    const a = parseGrid(o.fromGrid);
    const b = parseGrid(o.toGrid);
    if (!a || !b || (a.xi !== b.xi && a.yi !== b.yi) || (a.xi === b.xi && a.yi === b.yi)) {
      notes.push(`Opening ${o.mark} (${o.fromGrid}–${o.toGrid}) is not on one grid line and was skipped — place it by hand.`);
      continue;
    }
    const alongX = a.yi === b.yi;
    const coord = (p: { xi: number; yi: number }) => (alongX ? xs[p.xi] : ys[p.yi]);
    if (coord(a) === undefined || coord(b) === undefined) {
      notes.push(`Opening ${o.mark} refers to a grid point outside the grid and was skipped.`);
      continue;
    }
    const lo = coord(a) <= coord(b) ? a : b;
    const hi = lo === a ? b : a;
    const dirFromA = coord(b) >= coord(a) ? 1 : -1;
    const centreAbs = o.centreFromStartMm === null ? (coord(a) + coord(b)) / 2 : coord(a) + dirFromA * o.centreFromStartMm;
    // columns standing on this line between the two ends
    const line = alongX
      ? Array.from({ length: nx }, (_, xi) => xi).filter((xi) => xi >= lo.xi && xi <= hi.xi && layout[a.yi][xi])
      : Array.from({ length: ny }, (_, yi) => yi).filter((yi) => yi >= lo.yi && yi <= hi.yi && layout[yi][a.xi]);
    const pts = line.map((i) => (alongX ? { xi: i, yi: a.yi } : { xi: a.xi, yi: i }));
    let seg = -1;
    for (let i = 0; i < pts.length - 1; i++) if (centreAbs >= coord(pts[i]) - 1e-6 && centreAbs <= coord(pts[i + 1]) + 1e-6) seg = i;
    if (seg < 0) {
      notes.push(`Opening ${o.mark} (${o.fromGrid}–${o.toGrid}) does not fall between two columns and was skipped — place it by hand.`);
      continue;
    }
    const s = pts[seg];
    const e = pts[seg + 1];
    const key = `${gridLabel('X', s.xi)}${gridLabel('Y', s.yi)}-${gridLabel('X', e.xi)}${gridLabel('Y', e.yi)}`;
    const isCentred = o.centreFromStartMm === null && pts.length === 2;
    openings.push({ mark: o.mark.trim(), wall: key, offset: isCentred ? null : Math.round(centreAbs - coord(s)) });
  }

  // a boundary wall may come without pier positions: piers on every point of the line, or round the plot edge
  if (kind === 'boundary' && !r.columns.length) {
    const code = r.columnTypes[0]?.code.trim() ?? '';
    layout.forEach((row, y) => row.forEach((_, x) => (row[x] = ny === 1 || y === 0 || y === ny - 1 || x === 0 || x === nx - 1 ? code : '')));
  }
  const freeElements = r.elements.map((e) => ({ code: e.code.trim(), type: e.type, x: e.xMm, y: e.yMm, z: e.bottomMm, l: e.lengthMm, w: e.widthMm, h: e.heightMm }));
  if (kind === 'free' && !freeElements.length) notes.push('The AI did not list any elements — add them in section 2, or choose Building / Boundary wall.');

  const spec: BuilderSpec = {
    ...base,
    kind,
    ...(kind === 'free' ? { freeElements } : {}),
    ...(kind === 'rooms'
      ? {
          rooms: r.rooms.map(toRoom),
          roomOpenings: r.roomOpenings.map(toRoomOpening),
          upperFloors: r.upperFloors.map((fl, k) => ({
            name: fl.name.trim() || `Floor ${k + 1}`,
            height: Math.round(fl.floorToFloorMm) || r.roofLevelMm || d.roofLevel,
            rooms: fl.rooms.map(toRoom),
            roomOpenings: fl.roomOpenings.map(toRoomOpening),
          })),
          parapet: { enabled: r.parapet.present, h: Math.round(r.parapet.heightMm) || 1000, t: Math.round(r.parapet.thicknessMm) || 115 },
          mumty: { enabled: r.mumty.present, h: Math.round(r.mumty.heightMm) || 2440 },
          extraElements: [],
          omit: [],
        }
      : {}),
    projectName: r.projectName.trim() || base.projectName,
    buildingName: r.buildingName.trim() || r.projectName.trim() || base.buildingName,
    xSpans,
    ySpans,
    columnTypes: r.columnTypes.map((c) => ({ code: c.code.trim(), w: c.widthMm, d: c.depthMm, footing: c.footingCode.trim() })),
    footingTypes: r.footingTypes.map((f) => ({ code: f.code.trim(), w: f.lengthMm, d: f.widthMm, t: f.depthMm })),
    layout,
    foundationDepth: Math.abs(r.foundationDepthMm),
    roofLevel: r.roofLevelMm,
    plinthBeam: { enabled: r.plinthBeam.present, w: r.plinthBeam.widthMm || d.plinthBeam.w, h: r.plinthBeam.depthMm || d.plinthBeam.h },
    roofBeam: { enabled: r.roofBeam.present, w: r.roofBeam.widthMm || d.roofBeam.w, h: r.roofBeam.depthMm || d.roofBeam.h },
    slab: { enabled: r.slab.present && kind !== 'boundary', t: r.slab.thicknessMm || d.slab.t, overhang: Math.max(r.slab.overhangMm, 0) },
    walls: { enabled: r.walls.present || kind === 'rooms', t: r.walls.thicknessMm || d.walls.t, internal: r.walls.alsoOnInternalGridLines },
    openingTypes: r.openingTypes.map((o) => ({ mark: o.mark.trim(), kind: o.kind, w: o.widthMm, h: o.heightMm, sill: o.kind === 'door' ? 0 : Math.max(o.sillMm, 0) })),
    openings,
    lintel: { ...base.lintel, enabled: r.lintel.present, h: r.lintel.depthMm || d.lintel.h },
    chhajja: { ...base.chhajja, enabled: r.chhajja.present, projection: r.chhajja.projectionMm || d.chhajja.projection, t: r.chhajja.thicknessMm || d.chhajja.t },
  };
  return { spec, notes };
}

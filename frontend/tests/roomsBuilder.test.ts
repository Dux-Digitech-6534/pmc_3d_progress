import { describe, expect, it } from 'vitest';
import { buildModel, defaultSpec, removeElement, type BuilderSpec, type Room } from '../src/domain/modelBuilder';
import { validateModelDocument } from '../src/domain/modelValidation';

const FT = 304.8;
const ft = (n: number) => Math.round(n * FT);
/** The office concept sketch: 40 × 30 ft, three cabins and a pantry at the back, reception, hall, passage and washroom in front. */
const officeRooms: Room[] = [
  { name: 'Reception', x: 0, y: 0, w: ft(12), d: ft(18) },
  { name: 'Open office / hall', x: ft(12), y: 0, w: ft(20), d: ft(18) },
  { name: 'Washroom', x: ft(32), y: 0, w: ft(8), d: ft(8) },
  { name: 'Passage', x: ft(32), y: ft(8), w: ft(8), d: ft(10) },
  { name: 'Cabin 01', x: 0, y: ft(18), w: ft(12), d: ft(12) },
  { name: 'Cabin 02', x: ft(12), y: ft(18), w: ft(12), d: ft(12) },
  { name: 'Cabin 03', x: ft(24), y: ft(18), w: ft(10), d: ft(12) },
  { name: 'Pantry', x: ft(34), y: ft(18), w: ft(6), d: ft(12) },
];
const office = (over: Partial<BuilderSpec> = {}): BuilderSpec => ({
  ...defaultSpec(),
  kind: 'rooms',
  rooms: officeRooms,
  roomOpenings: [
    { type: 'door', x: ft(6), y: 0, width: 1000, height: 2100, sill: 0 }, // main entry, front wall of reception
    { type: 'door', x: ft(18), y: ft(18), width: 900, height: 2100, sill: 0 }, // cabin 02 from the hall
    { type: 'window', x: ft(40), y: ft(24), width: 1200, height: 1200, sill: 900 }, // pantry side wall
  ],
  walls: { enabled: true, t: 230, internal: true },
  openings: [],
  ...over,
});

/** Wall lines of a built model, as "x" / "y" + position (mm, from the front-left corner) for checking. */
function wallSet(spec: BuilderSpec) {
  const res = buildModel(spec);
  expect(res.errors).toEqual([]);
  return res;
}

describe('building from rooms', () => {
  it('builds walls only where rooms have edges, columns at corners and junctions, one shared wall per edge', () => {
    const res = wallSet(office());
    const els = res.document!.elements;
    const walls = els.filter((e) => e.type === 'wall');
    const cols = els.filter((e) => e.type === 'column');
    expect(cols.length).toBe(els.filter((e) => e.type === 'footing').length);
    // the hall has no wall at 24 ft (that line exists only between the cabins at the back)
    const centreX = ft(40) / 2;
    const x24 = (ft(24) - centreX) / 1000;
    const frontHalfZ = 0; // the front part of the plan is +Z in 3D (plan Y 0 … 18 ft)
    const wallAcrossHallAt24 = walls.some((w) => w.geometry.size[2] > w.geometry.size[0] && Math.abs(w.geometry.position[0] - x24) < 0.01 && w.geometry.position[2] > frontHalfZ);
    expect(wallAcrossHallAt24).toBe(false);
    // …but there is one between cabin 02 and cabin 03 at the back
    expect(walls.some((w) => w.geometry.size[2] > w.geometry.size[0] && Math.abs(w.geometry.position[0] - x24) < 0.01 && w.geometry.position[2] < 0)).toBe(true);
    // no wall piece is longer than the column span
    expect(Math.max(...walls.map((w) => Math.max(w.geometry.size[0], w.geometry.size[2])))).toBeLessThanOrEqual(4.5);
    expect(res.summary!.slabs).toBe(1);
    expect(validateModelDocument(res.document).errors).toEqual([]);
  });

  it('puts doors and windows into their wall with a lintel, and takes them off the brickwork', () => {
    const res = wallSet(office());
    expect(res.summary).toMatchObject({ doors: 2, windows: 1, lintels: 3 });
    const holes = res.document!.elements.filter((e) => e.type === 'wall' && e.geometry.shape === 'wall' && e.geometry.openings?.length);
    expect(holes.length).toBe(3);
    const solid = wallSet(office({ roomOpenings: [] }));
    expect(res.summary!.brickwork).toBeLessThan(solid.summary!.brickwork);
  });

  it('a door that is not on any wall is reported, not placed', () => {
    const res = buildModel(office({ roomOpenings: [{ type: 'door', x: ft(6), y: ft(9), width: 900, height: 2100, sill: 0 }] }));
    expect(res.errors).toEqual([]);
    expect(res.summary!.doors).toBe(0);
    expect(res.warnings.some((w) => /not on a wall/.test(w))).toBe(true);
  });

  it('one generated element can be removed (and restored) without touching the rooms', () => {
    const res = wallSet(office());
    const wall = res.document!.elements.find((e) => e.type === 'wall')!;
    const next = removeElement(office(), res.refs[wall.id]);
    const after = buildModel(next);
    expect(after.summary!.walls).toBe(res.summary!.walls - 1);
    expect(buildModel({ ...next, omit: [] }).summary!.walls).toBe(res.summary!.walls);
  });

  it('explains missing or bad rooms', () => {
    expect(buildModel(office({ rooms: [] })).errors[0]).toMatch(/at least one room/);
    expect(buildModel(office({ rooms: [{ name: 'X', x: 0, y: 0, w: 0, d: 3000 }] })).errors[0]).toMatch(/Room 1 \(X\): width and depth/);
  });
});

describe('G+1 building from rooms', () => {
  // ground floor: two rooms 7.52 × 9.65 m; first floor smaller at the back, the front is an open terrace
  const ground: Room[] = [
    { name: 'Living', x: 0, y: 0, w: 3760, d: 4800 },
    { name: 'Kitchen', x: 3760, y: 0, w: 3760, d: 4800 },
    { name: 'Bed room', x: 0, y: 4800, w: 7520, d: 4850 },
  ];
  const g1 = (over: Partial<BuilderSpec> = {}): BuilderSpec => ({
    ...defaultSpec(),
    kind: 'rooms',
    rooms: ground,
    roomOpenings: [{ type: 'door', x: 1800, y: 0, width: 1000, height: 2100, sill: 0 }],
    walls: { enabled: true, t: 230, internal: true },
    openings: [],
    roofLevel: 3050,
    upperFloors: [
      {
        name: 'First floor',
        height: 3050,
        rooms: [{ name: 'Bed room', x: 0, y: 4800, w: 7520, d: 4850 }],
        roomOpenings: [{ type: 'door', x: 1800, y: 4800, width: 900, height: 2100, sill: 0 }],
      },
    ],
    parapet: { enabled: true, h: 1000, t: 115 },
    ...over,
  });

  it('stacks the first floor on the ground-floor slab, with its own columns, walls, door and roof slab', () => {
    const res = buildModel(g1());
    expect(res.errors).toEqual([]);
    const doc = res.document!;
    expect(validateModelDocument(doc).errors ?? []).toEqual([]);
    expect(doc.levels.map((l) => [l.id, l.elevation])).toEqual([['FDN', -1], ['GF', 0], ['1F', 3.175], ['RF', 6.1]]);
    const of = (lvl: string, type: string) => doc.elements.filter((e) => e.levelId === lvl && e.type === type);
    // first floor: one room → 4 corners + one more along each wall longer than 4500 mm, all on ground columns
    expect(of('1F', 'column')).toHaveLength(8);
    const fcol = of('1F', 'column')[0];
    expect(fcol.geometry.position[1] - fcol.geometry.size[1] / 2).toBeCloseTo(3.175, 3);
    expect(of('1F', 'door')).toHaveLength(1);
    expect(doc.elements.filter((e) => e.type === 'slab').map((e) => [e.code, e.levelId])).toEqual([['SL-RF', '1F'], ['1F-SL', 'RF']]);
    expect(doc.elements.filter((e) => e.type === 'footing')).toHaveLength(of('GF', 'column').length);
    expect(res.warnings.join(' ')).not.toContain('do not stand on a column');
  });

  it('puts a parapet round the open terrace and the top roof, not under the first-floor walls', () => {
    const doc = buildModel(g1()).document!;
    const pp = doc.elements.filter((e) => /PP\d/.test(e.code));
    const ground = pp.filter((e) => e.levelId === '1F');
    const top = pp.filter((e) => e.levelId === 'RF');
    expect(top).toHaveLength(4);
    // the terrace is the front half: front edge + front parts of both sides, nothing along the back
    expect(ground).toHaveLength(3);
    for (const e of ground) expect(e.geometry.position[1]).toBeCloseTo(3.05 + 0.125 + 0.5, 3);
  });

  it('reports a column with nothing below it and a missing upper floor plan', () => {
    const shifted = g1({ upperFloors: [{ name: 'First floor', height: 3050, rooms: [{ name: 'Room', x: 1000, y: 4800, w: 5000, d: 4850 }], roomOpenings: [] }] });
    expect(buildModel(shifted).warnings.join(' ')).toContain('do not stand on a column');
    expect(buildModel(g1({ upperFloors: [{ name: 'First floor', height: 3050, rooms: [], roomOpenings: [] }] })).errors).toContain('First floor: add at least one room (section 2).');
  });

  it('keeps single-storey models as before (no extra level, roof slab on RF)', () => {
    const doc = buildModel(g1({ upperFloors: [], parapet: undefined })).document!;
    expect(doc.levels.map((l) => l.id)).toEqual(['FDN', 'GF', 'RF']);
    expect(doc.elements.find((e) => e.type === 'slab')!.levelId).toBe('RF');
  });
});

describe('staircase in the stair room', () => {
  const stair: Room = { name: 'Stair', x: 0, y: 0, w: 2600, d: 4800 };
  const spec = (over: Partial<BuilderSpec> = {}): BuilderSpec => ({
    ...defaultSpec(),
    kind: 'rooms',
    rooms: [stair, { name: 'Hall', x: 2600, y: 0, w: 4000, d: 4800 }],
    roomOpenings: [],
    walls: { enabled: true, t: 230, internal: true },
    openings: [],
    roofLevel: 3050,
    upperFloors: [{ name: 'First floor', height: 3050, rooms: [stair, { name: 'Bed room', x: 2600, y: 0, w: 4000, d: 4800 }], roomOpenings: [] }],
    ...over,
  });

  it('builds two flights and a landing on every floor, up to the next floor and to the roof', () => {
    const res = buildModel(spec());
    expect(res.errors).toEqual([]);
    const doc = res.document!;
    expect(validateModelDocument(doc).errors ?? []).toEqual([]);
    const codes = doc.elements.filter((e) => /ST\d/.test(e.code)).map((e) => e.code);
    expect(codes.sort()).toEqual(['1F-ST1-1', '1F-ST1-2', '1F-ST1-LD', 'ST1-1', 'ST1-2', 'ST1-LD']);
    const f1 = doc.elements.find((e) => e.code === 'ST1-1')!;
    const f2 = doc.elements.find((e) => e.code === 'ST1-2')!;
    expect(f1.geometry.shape).toBe('stair');
    // ground to first-floor level 3.175 m: two flights of half that, the second starting where the first ends
    expect(f1.geometry.size[1]).toBeCloseTo(3.175 / 2, 3);
    expect(f2.geometry.position[1] - f2.geometry.size[1] / 2).toBeCloseTo(3.175 / 2, 3);
    // the room is deeper than wide: flights climb along plan Y (−Z in 3D), side by side, in opposite directions
    expect(f1.geometry).toMatchObject({ up: '-z', steps: 10 });
    expect(f2.geometry).toMatchObject({ up: '+z' });
    expect(f1.plannedQuantities.CONC.quantity).toBeGreaterThan(0.3);
    expect(f1.levelId).toBe('GF');
    expect(doc.elements.find((e) => e.code === '1F-ST1-1')!.levelId).toBe('1F');
  });

  it('leaves out a stair that does not fit, and a flight removed by hand', () => {
    const tiny = buildModel(spec({ rooms: [{ name: 'Stair', x: 0, y: 0, w: 1000, d: 1500 }], upperFloors: [] }));
    expect(tiny.warnings.join(' ')).toContain('too small for a dog-legged stair');
    const res = buildModel(spec({ omit: ['ST1-2'] }));
    expect(res.document!.elements.some((e) => e.code === 'ST1-2')).toBe(false);
    expect(res.document!.elements.some((e) => e.code === 'ST1-1')).toBe(true);
  });
});

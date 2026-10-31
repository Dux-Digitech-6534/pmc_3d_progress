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

describe('open spaces, balconies, terraces, mumty, stair opening, chhajjas, plan checks', () => {
  // a 22 × 30 ft style house: parking (open) in front, rooms behind; first floor with a front balcony and a back terrace
  const house = (over: Partial<BuilderSpec> = {}): BuilderSpec => ({
    ...defaultSpec(),
    kind: 'rooms',
    rooms: [
      { name: 'Parking', kind: 'open', x: 0, y: 0, w: 3000, d: 3600 },
      { name: 'Drawing room', x: 3000, y: 0, w: 3700, d: 3600 },
      { name: 'Stair', x: 0, y: 3600, w: 2600, d: 4500 },
      { name: 'Kitchen', x: 2600, y: 3600, w: 4100, d: 4500 },
    ],
    roomOpenings: [
      { type: 'window', x: 4850, y: 0, width: 1500, height: 1200, sill: 900 }, // front wall of the drawing room (outside)
      { type: 'door', x: 4850, y: 3600, width: 900, height: 2100, sill: 0 }, // drawing room → kitchen (inside)
    ],
    walls: { enabled: true, t: 230, internal: true },
    openings: [],
    roofLevel: 3050,
    chhajja: { enabled: true, projection: 450, t: 75, overDoors: true },
    upperFloors: [
      {
        name: 'First floor',
        height: 3050,
        rooms: [
          { name: 'Balcony', kind: 'balcony', x: 0, y: -1200, w: 6700, d: 1200 },
          { name: 'Bed room', x: 0, y: 0, w: 6700, d: 3600 },
          { name: 'Stair', x: 0, y: 3600, w: 2600, d: 4500 },
          { name: 'Terrace', kind: 'terrace', x: 2600, y: 3600, w: 4100, d: 4500 },
        ],
        roomOpenings: [{ type: 'door', x: 3350, y: 0, width: 900, height: 2100, sill: 0 }],
      },
    ],
    parapet: { enabled: true, h: 1000, t: 115 },
    ...over,
  });
  const built = (over: Partial<BuilderSpec> = {}) => {
    const res = buildModel(house(over));
    expect(res.errors).toEqual([]);
    expect(validateModelDocument(res.document!).errors ?? []).toEqual([]);
    return res;
  };
  const els = (res: ReturnType<typeof buildModel>) => res.document!.elements;

  it('builds no walls on the open sides of the parking, but keeps its columns and beams', () => {
    const res = built();
    const walls = els(res).filter((e) => e.type === 'wall' && e.levelId === 'GF');
    // ground floor wall pieces: none on the parking front edge (y = 0, x 0..3000) nor its left side
    const cx = 3350, cy = 4050; // centre of the ground frame in plan mm
    const onParkingFront = walls.filter((e) => Math.abs(-e.geometry.position[2] * 1000 + cy - 0) < 20 && e.geometry.position[0] * 1000 + cx < 3000);
    expect(onParkingFront).toEqual([]);
    expect(els(res).filter((e) => e.type === 'column' && e.levelId === 'GF').length).toBeGreaterThanOrEqual(8);
  });

  it('puts a cantilever balcony slab with railings, builds nothing on the terrace, and a mumty over the top stair', () => {
    const res = built();
    const codes = els(res).map((e) => e.code);
    expect(codes).toContain('1F-BAL1');
    expect(codes.filter((c) => c.startsWith('1F-BAL1-R'))).toHaveLength(3); // front + both ends; the back is the bed room wall
    // terrace: no first-floor wall inside the terrace area, and no columns only for it
    expect(codes.some((c) => c.startsWith('MT-C'))).toBe(true);
    expect(codes).toContain('MT-SL');
    expect(codes.filter((c) => c.startsWith('MT-D'))).toHaveLength(1);
    const mt = els(res).find((e) => e.code === 'MT-SL')!;
    expect(mt.levelId).toBe('RF');
    expect(res.document!.levels.map((l) => l.id)).toEqual(['FDN', 'GF', '1F', 'RF']);
    // no mumty when switched off
    expect(built({ mumty: { enabled: false, h: 2440 } }).document!.elements.some((e) => e.code.startsWith('MT-'))).toBe(false);
  });

  it('leaves the slab open over the stair (slab per room) and keeps one slab when there is no stair', () => {
    const res = built();
    const gfSlabs = els(res).filter((e) => e.code.startsWith('SL-RF'));
    expect(gfSlabs.length).toBe(3); // parking, drawing room, kitchen — not the stair
    const stairCentre = { x: (1300 - 3350) / 1000, z: -(5850 - 4050) / 1000 };
    for (const s of gfSlabs) {
      const [x, , z] = s.geometry.position;
      const [l, , w] = s.geometry.size;
      const covers = Math.abs(x - stairCentre.x) < l / 2 && Math.abs(z - stairCentre.z) < w / 2;
      expect(covers).toBe(false);
    }
    const noStair = built({ rooms: house().rooms!.map((r) => (r.name === 'Stair' ? { ...r, name: 'Store' } : r)), upperFloors: [] });
    expect(els(noStair).filter((e) => e.type === 'slab').map((e) => e.code)).toEqual(['SL-RF']);
  });

  it('puts a chhajja over the outside window only', () => {
    const res = built();
    const ch = els(res).filter((e) => e.type === 'chhajja' && e.levelId === 'GF');
    expect(ch.map((e) => e.code)).toEqual(['CH-WN1']);
    // it projects outside: in front of the front wall (plan y < 0 → world z > front wall)
    const wallZ = (4050 - 0) / 1000;
    expect(ch[0].geometry.position[2]).toBeGreaterThan(wallZ);
  });

  it('notes overlapping rooms, a plan with a gap, and an upper floor off the floor below', () => {
    const overlap = buildModel(house({ rooms: [...house().rooms!, { name: 'Toilet', x: 5000, y: 3000, w: 1500, d: 1500 }], upperFloors: [] }));
    // a small overlap is cut back and noted; a room lying mostly inside another stays and is noted as an overlap
    expect(overlap.warnings.join(' ')).toMatch(/"Kitchen" overlapped "Toilet" by [\d.]+ m² and was cut back/);
    const inside = buildModel(house({ rooms: [...house().rooms!, { name: 'Store', x: 3200, y: 4000, w: 3000, d: 3500 }], upperFloors: [] }));
    expect(inside.warnings.join(' ')).toMatch(/"Kitchen" and "Store" overlap by/);
    const gap = buildModel(house({ rooms: house().rooms!.filter((r) => r.name !== 'Kitchen'), upperFloors: [] }));
    expect(gap.warnings.join(' ')).toMatch(/cover only \d+ %/);
    const shifted = buildModel(
      house({ upperFloors: [{ name: 'First floor', height: 3050, rooms: [{ name: 'Bed room', x: 2000, y: 0, w: 6700, d: 3600 }], roomOpenings: [] }] }),
    );
    expect(shifted.warnings.join(' ')).toMatch(/stick.* out more than 600 mm/);
  });
});

describe('a 22 × 30 ft plan read with small errors (walls a little apart, rooms overlapping)', () => {
  // as an AI reading tends to give it: the kitchen's right edge 150 mm past the lobby's left edge,
  // the drawing room 150 mm deeper than where the lobby starts, and the lobby reaching into the stair
  const f = (n: number) => Math.round(n * 304.8);
  const spec = (): BuilderSpec => ({
    ...defaultSpec(),
    kind: 'rooms',
    rooms: [
      { name: 'Porch', kind: 'open', x: 0, y: 0, w: f(9.5), d: f(8) },
      { name: 'Drawing room', x: f(9.5), y: 0, w: f(10.5), d: f(11.6) + 150 },
      { name: 'Stair', x: 0, y: f(8), w: f(9.5), d: f(7.4) },
      { name: 'Lobby', x: f(9.5) - 400, y: f(11.6), w: f(10.5) + 400, d: f(8.3) },
      { name: 'Kitchen', x: 0, y: f(15.4), w: f(9.5) + 150, d: f(5.2) },
      { name: 'Bed room', x: 0, y: f(20.6), w: f(14), d: f(9.4) },
      { name: 'Toilet', x: f(14), y: f(19.9), w: f(6), d: f(5.7) },
      { name: 'OTS', x: f(15.4), y: f(25.6), w: f(4.6), d: f(4.4) },
    ],
    roomOpenings: [
      { type: 'door', x: f(9.5), y: f(1.7), width: 900, height: 2100, sill: 0 }, // drawing room main door, from the porch
      { type: 'door', x: f(9.5), y: f(13.5), width: 900, height: 2100, sill: 0 }, // stair landing → lobby
      { type: 'door', x: f(11), y: f(20.6), width: 900, height: 2100, sill: 0 }, // lobby → bed room
    ],
    walls: { enabled: true, t: 230, internal: true },
    openings: [],
    mumty: { enabled: false, h: 2440 },
  });

  it('builds one wall per line (no wall right in front of a door) and no wall across the stair', () => {
    const res = buildModel(spec());
    expect(res.errors).toEqual([]);
    const doc = res.document!;
    expect(validateModelDocument(doc).errors ?? []).toEqual([]);
    const walls = doc.elements.filter((e) => e.type === 'wall');
    // no two parallel walls closer than 300 mm that run side by side
    for (const a of walls)
      for (const b of walls) {
        if (a === b) continue;
        const ax = a.geometry.size[0] >= a.geometry.size[2];
        const bx = b.geometry.size[0] >= b.geometry.size[2];
        if (ax !== bx) continue;
        const [i, j] = ax ? [2, 0] : [0, 2];
        const gap = Math.abs(a.geometry.position[i] - b.geometry.position[i]);
        const overlap = Math.min(a.geometry.position[j] + a.geometry.size[j] / 2, b.geometry.position[j] + b.geometry.size[j] / 2) - Math.max(a.geometry.position[j] - a.geometry.size[j] / 2, b.geometry.position[j] - b.geometry.size[j] / 2);
        if (gap > 0.01 && gap < 0.3) expect(overlap).toBeLessThanOrEqual(0.05);
      }
    expect(res.warnings.join(' ')).not.toMatch(/stands \d+ mm in front of this door/);
    expect(res.warnings.join(' ')).toMatch(/lined up with it/);
    // the lobby read into the stair: no wall through the stair, and it is reported
    expect(res.warnings.join(' ')).toMatch(/"Lobby" overlapped "Stair" by [\d.]+ m² and was cut back/);
    // the stair flights stay inside the stair room (between its side walls)
    const st = doc.elements.filter((e) => /^ST\d+-/.test(e.code));
    expect(st).toHaveLength(3);
    // and inside the stair room on plan: x 0 … 9.5 ft from the left, i.e. left of the stair's right wall
    const xs = doc.elements.filter((e) => e.type === 'column').map((e) => e.geometry.position[0]);
    const left = Math.min(...xs);
    for (const e of st) expect(e.geometry.position[0] + e.geometry.size[0] / 2).toBeLessThanOrEqual(left + f(9.5) / 1000 + 0.001);
    expect(doc.elements.filter((e) => e.type === 'door')).toHaveLength(3);
  });
});

describe('doors and windows placed by the two rooms they join', () => {
  const f = (n: number) => Math.round(n * 304.8);
  const rooms: Room[] = [
    { name: 'Porch', kind: 'open', x: 0, y: 0, w: f(9.5), d: f(11.6) },
    { name: 'Drawing room', x: f(9.5), y: 0, w: f(10.5), d: f(11.6) },
    { name: 'Lobby', x: 0, y: f(11.6), w: f(20), d: f(8) },
  ];
  const spec = (roomOpenings: BuilderSpec['roomOpenings']): BuilderSpec => ({
    ...defaultSpec(),
    kind: 'rooms',
    rooms,
    roomOpenings,
    walls: { enabled: true, t: 230, internal: true },
    openings: [],
  });
  /** Plan position (mm, from the building's front-left corner) of a built element's centre. */
  const planOf = (res: ReturnType<typeof buildModel>, code: string) => {
    const doc = res.document!;
    const cols = doc.elements.filter((e) => e.type === 'column');
    const minX = Math.min(...cols.map((e) => e.geometry.position[0]));
    const maxZ = Math.max(...cols.map((e) => e.geometry.position[2]));
    const e = doc.elements.find((x) => x.code === code)!;
    return { x: Math.round((e.geometry.position[0] - minX) * 1000), y: Math.round((maxZ - e.geometry.position[2]) * 1000) };
  };

  it('puts the drawing-room door in the wall to the porch even when its X / Y says the front wall', () => {
    // read wrongly at the front wall, near the left corner of the drawing room
    const res = buildModel(spec([
      { type: 'door', x: f(10.5), y: 0, width: 900, height: 2100, sill: 0, between: ['Drawing room', 'Porch'] },
      { type: 'window', x: f(15), y: 0, width: 1500, height: 1200, sill: 900, between: ['Drawing room', 'outside'] },
    ]));
    expect(res.errors).toEqual([]);
    const d = planOf(res, 'D1');
    expect(Math.abs(d.x - f(9.5))).toBeLessThan(5); // on the porch wall (x = 9.5 ft)
    expect(d.y).toBeGreaterThan(300);
    const w = planOf(res, 'WN1');
    expect(Math.abs(w.y)).toBeLessThan(5); // front wall
    expect(w.x).toBeGreaterThan(f(9.5));
  });

  it('accepts "outside" first, ignores case, and notes a pair that shares no wall or an unknown room', () => {
    const ok = buildModel(spec([{ type: 'window', x: f(15), y: 100, width: 1200, height: 1200, sill: 900, between: ['outside', 'drawing ROOM'] }]));
    expect(Math.abs(planOf(ok, 'WN1').y)).toBeLessThan(5);
    const none = buildModel(spec([{ type: 'door', x: f(5), y: f(11.6), width: 900, height: 2100, sill: 0, between: ['Porch', 'Kitchen'] }]));
    expect(none.warnings.join(' ')).toMatch(/no room named "Kitchen"/);
    const apart = buildModel(spec([{ type: 'door', x: f(5), y: 0, width: 900, height: 2100, sill: 0, between: ['Porch', 'Lobby'] }]));
    // the porch has no walls of its own; its edge to the lobby is the lobby's wall, so it is found
    expect(Math.abs(planOf(apart, 'D1').y - f(11.6))).toBeLessThanOrEqual(10); // walls sit on 10 mm lines
  });
});

describe('an opening whose two rooms share no wall', () => {
  it('is not put in some other wall near its X / Y', () => {
    const res = buildModel({
      ...defaultSpec(),
      kind: 'rooms',
      rooms: [
        { name: 'Bed room', x: 0, y: 0, w: 4000, d: 3000 },
        { name: 'Toilet', x: 4000, y: 0, w: 2000, d: 1500 },
        { name: 'OTS', x: 4500, y: 1500, w: 1500, d: 1500 },
      ],
      // Bed room and OTS do not touch (the toilet's corner is between); X / Y is on the OTS outside wall
      roomOpenings: [{ type: 'door', x: 6000, y: 2200, width: 750, height: 2100, sill: 0, between: ['Bed room', 'Store'] }],
      walls: { enabled: true, t: 230, internal: true },
      openings: [],
    });
    expect(res.warnings.join(' ')).toMatch(/no room named "Store"/);
    const res2 = buildModel({
      ...defaultSpec(),
      kind: 'rooms',
      rooms: [
        { name: 'Bed room', x: 0, y: 0, w: 4000, d: 3000 },
        { name: 'Hall', x: 4000, y: 0, w: 500, d: 3000 },
        { name: 'OTS', x: 4500, y: 0, w: 1500, d: 3000 },
      ],
      roomOpenings: [{ type: 'door', x: 6000, y: 1500, width: 750, height: 2100, sill: 0, between: ['Bed room', 'OTS'] }],
      walls: { enabled: true, t: 230, internal: true },
      openings: [],
    });
    expect(res2.warnings.join(' ')).toMatch(/share no wall and its X \/ Y is not on a wall of either — not built/);
    expect(res2.document!.elements.some((e) => e.type === 'door')).toBe(false);
  });
});

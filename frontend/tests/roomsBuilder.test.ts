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

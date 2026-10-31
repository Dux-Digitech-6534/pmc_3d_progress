import { describe, expect, it } from 'vitest';
import { DrawingReadingSchema, parseGrid, readingToSpec, withReadingDefaults, type DrawingReading } from '../src/ai/drawingSchema';
import { buildModel, defaultSpec } from '../src/domain/modelBuilder';
import { validateModelDocument } from '../src/domain/modelValidation';

/** What a good reading of the "Typical Drawing of Security Cabin" looks like. */
const cabin = (): DrawingReading => ({
  structureKind: 'building',
  elements: [],
  rooms: [],
  roomOpenings: [],
  upperFloors: [],
  parapet: { present: false, heightMm: 0, thicknessMm: 0 },
  mumty: { present: false, heightMm: 0 },
  projectName: 'Security Cabin',
  buildingName: 'Security Cabin',
  xSpansMm: [3230],
  ySpansMm: [3230],
  columnTypes: [{ code: 'C1', widthMm: 230, depthMm: 230, footingCode: 'F1' }],
  footingTypes: [{ code: 'F1', lengthMm: 1200, widthMm: 1200, depthMm: 300 }],
  columns: [
    { grid: 'X1Y1', columnCode: 'C1' },
    { grid: 'X2Y1', columnCode: 'C1' },
    { grid: 'X1Y2', columnCode: 'C1' },
    { grid: 'X2Y2', columnCode: 'C1' },
  ],
  foundationDepthMm: 1200,
  roofLevelMm: 3000,
  plinthBeam: { present: true, widthMm: 230, depthMm: 300 },
  roofBeam: { present: true, widthMm: 230, depthMm: 300 },
  slab: { present: true, thicknessMm: 125, overhangMm: 450 },
  walls: { present: true, thicknessMm: 230, alsoOnInternalGridLines: false },
  openingTypes: [
    { mark: 'D', kind: 'door', widthMm: 900, heightMm: 2100, sillMm: 0 },
    { mark: 'W', kind: 'window', widthMm: 1500, heightMm: 1200, sillMm: 900 },
    { mark: 'V', kind: 'ventilator', widthMm: 600, heightMm: 450, sillMm: 1800 },
  ],
  openings: [
    { mark: 'D', fromGrid: 'X1Y1', toGrid: 'X2Y1', centreFromStartMm: 800 },
    { mark: 'W', fromGrid: 'X2Y1', toGrid: 'X2Y2', centreFromStartMm: null },
    { mark: 'V', fromGrid: 'X2Y2', toGrid: 'X1Y2', centreFromStartMm: 700 }, // given right-to-left
  ],
  lintel: { present: true, depthMm: 150 },
  chhajja: { present: true, projectionMm: 450, thicknessMm: 75 },
  assumptions: ['Footing size not on drawing; typical 1200 × 1200 × 300 assumed.'],
  confidence: 'medium',
});

describe('AI drawing reading → builder spec', () => {
  it('the reading matches the schema the AI is held to', () => {
    expect(DrawingReadingSchema.safeParse(cabin()).success).toBe(true);
  });

  it('parses grid labels leniently', () => {
    expect(parseGrid('X2Y1')).toEqual({ xi: 1, yi: 0 });
    expect(parseGrid(' x1 / y3 ')).toEqual({ xi: 0, yi: 2 });
    expect(parseGrid('A1')).toBeNull();
  });

  it('turns a cabin reading into a valid model with the openings on the right walls', () => {
    const { spec, notes } = readingToSpec(cabin(), defaultSpec());
    expect(notes).toEqual([]);
    expect(spec.projectId).toBe(defaultSpec().projectId); // header stays from the form
    expect(spec.layout).toEqual([['C1', 'C1'], ['C1', 'C1']]);
    expect(spec.openings).toEqual([
      { mark: 'D', wall: 'X1Y1-X2Y1', offset: 800 },
      { mark: 'W', wall: 'X2Y1-X2Y2', offset: null },
      { mark: 'V', wall: 'X1Y2-X2Y2', offset: 3230 - 700 }, // measured from X1Y2 instead
    ]);
    const res = buildModel(spec);
    expect(res.errors).toEqual([]);
    expect(res.summary).toMatchObject({ footings: 4, columns: 4, walls: 4, doors: 1, windows: 2, lintels: 3, chhajjas: 3 });
    expect(validateModelDocument(res.document).ok).toBe(true);
  });

  it('puts an opening of a long wall into the bay that contains it', () => {
    const r = cabin();
    r.xSpansMm = [3000, 3000];
    r.columns = ['X1Y1', 'X2Y1', 'X3Y1', 'X1Y2', 'X2Y2', 'X3Y2'].map((grid) => ({ grid, columnCode: 'C1' }));
    r.openings = [{ mark: 'W', fromGrid: 'X1Y1', toGrid: 'X3Y1', centreFromStartMm: 4500 }];
    const { spec } = readingToSpec(r, defaultSpec());
    expect(spec.openings).toEqual([{ mark: 'W', wall: 'X2Y1-X3Y1', offset: 1500 }]);
    expect(buildModel(spec).errors).toEqual([]);
  });

  it('reports what it could not place instead of guessing', () => {
    const r = cabin();
    r.columns.push({ grid: 'X9Y9', columnCode: 'C1' });
    r.openings = [{ mark: 'W', fromGrid: 'X1Y1', toGrid: 'X2Y2', centreFromStartMm: null }]; // diagonal
    const { notes, spec } = readingToSpec(r, defaultSpec());
    expect(notes.join(' ')).toMatch(/X9Y9.*outside/);
    expect(notes.join(' ')).toMatch(/not on one grid line/);
    expect(spec.openings).toEqual([]);
  });
});

describe('AI reading → structure type', () => {
  it('a boundary wall reading without pier positions fills every point of the line, no slab', () => {
    const r: DrawingReading = { ...cabin(), structureKind: 'boundary-wall', xSpansMm: [3000, 3000, 3000], ySpansMm: [], columns: [], openings: [], slab: { present: true, thicknessMm: 120, overhangMm: 0 } };
    const { spec } = readingToSpec(r, defaultSpec());
    expect(spec.kind).toBe('boundary');
    expect(spec.layout).toEqual([['C1', 'C1', 'C1', 'C1']]);
    expect(spec.slab.enabled).toBe(false);
    expect(buildModel(spec).errors).toEqual([]);
  });

  it('"other" becomes a free model from the listed elements', () => {
    const r: DrawingReading = {
      ...cabin(),
      structureKind: 'other',
      elements: [{ code: 'T1', type: 'slab', xMm: 0, yMm: 0, bottomMm: 0, lengthMm: 2000, widthMm: 2000, heightMm: 200 }],
    };
    const { spec } = readingToSpec(r, defaultSpec());
    expect(spec.kind).toBe('free');
    expect(spec.freeElements).toEqual([{ code: 'T1', type: 'slab', x: 0, y: 0, z: 0, l: 2000, w: 2000, h: 200 }]);
  });

  it('an answer from an older server (no structure type) is read as a building', () => {
    const { structureKind: _k, elements: _e, ...old } = cabin();
    const parsed = DrawingReadingSchema.safeParse(withReadingDefaults(old));
    expect(parsed.success).toBe(true);
    expect(readingToSpec(parsed.data!, defaultSpec()).spec.kind).toBe('building');
  });
});

describe('reading a house with open spaces, a balcony and a mumty', () => {
  it('keeps each space kind and the mumty, and builds a valid model from them', () => {
    const room = (name: string, kind: 'room' | 'open' | 'balcony' | 'terrace', xMm: number, yMm: number, widthMm: number, depthMm: number) => ({ name, kind, xMm, yMm, widthMm, depthMm });
    const r: DrawingReading = {
      ...cabin(),
      rooms: [room('Parking', 'open', 0, 0, 3000, 3600), room('Hall', 'room', 3000, 0, 3700, 3600), room('Stair', 'room', 0, 3600, 2600, 4500), room('Kitchen', 'room', 2600, 3600, 4100, 4500)],
      upperFloors: [
        {
          name: 'First floor',
          floorToFloorMm: 3050,
          rooms: [room('Balcony', 'balcony', 0, -1200, 6700, 1200), room('Bed room', 'room', 0, 0, 6700, 3600), room('Stair', 'room', 0, 3600, 2600, 4500), room('Terrace', 'terrace', 2600, 3600, 4100, 4500)],
          roomOpenings: [],
        },
      ],
      parapet: { present: true, heightMm: 1000, thicknessMm: 115 },
      mumty: { present: true, heightMm: 2600 },
    };
    expect(DrawingReadingSchema.safeParse(r).success).toBe(true);
    const { spec } = readingToSpec(r, defaultSpec());
    expect(spec.rooms![0]).toMatchObject({ name: 'Parking', kind: 'open' });
    expect(spec.rooms![1].kind).toBeUndefined();
    expect(spec.upperFloors![0].rooms.map((x) => x.kind ?? 'room')).toEqual(['balcony', 'room', 'room', 'terrace']);
    expect(spec.mumty).toEqual({ enabled: true, h: 2600 });
    const res = buildModel(spec);
    expect(res.errors).toEqual([]);
    expect(validateModelDocument(res.document!).errors ?? []).toEqual([]);
    expect(res.document!.elements.some((e) => e.code === 'MT-SL')).toBe(true);
  });
});

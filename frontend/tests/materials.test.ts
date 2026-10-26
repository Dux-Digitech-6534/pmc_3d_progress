import { describe, expect, it } from 'vitest';
import { buildModel, defaultSpec } from '../src/domain/modelBuilder';
import {
  approvedOf,
  CONCRETE_MIXES,
  DEFAULT_MATERIAL_NORMS,
  materialsFor,
  normErrors,
  normsOf,
  projectMaterials,
  withNormDefaults,
} from '../src/domain/materials';
import type { ElementRecord, ProgressEntry } from '../src/domain/types';

const n = DEFAULT_MATERIAL_NORMS;

describe('materials from work quantities', () => {
  it('concrete: M20 1:1.5:3 needs about 8 bags of cement, 0.42 m³ sand and 0.84 m³ aggregate per m³', () => {
    const m = materialsFor({ CONC: 1 }, n);
    expect(m.cement).toBeCloseTo(8.06, 2);
    expect(m.sand).toBeCloseTo(0.42);
    expect(m.aggregate).toBeCloseTo(0.84);
    expect(m.bricks).toBe(0);
  });

  it('brickwork and plaster: bricks, cement and sand; steel is the reinforcement kg; wastage is added', () => {
    const m = materialsFor({ BRICK: 2, PLAST: 10, REINF: 100 }, { ...n, wastagePct: 5 });
    expect(m.bricks).toBeCloseTo(2 * 500 * 1.05);
    expect(m.cement).toBeCloseTo(((2 * 68 + 10 * 3.3) / 50) * 1.05);
    expect(m.sand).toBeCloseTo((2 * 0.285 + 10 * 0.0137) * 1.05);
    expect(m.steel).toBeCloseTo(105);
  });

  it('checks the norms', () => {
    expect(normErrors(n)).toEqual([]);
    expect(normErrors({ ...n, wastagePct: 80 })[0]).toMatch(/Wastage/);
    expect(normErrors({ ...n, bagKg: 0 })[0]).toMatch(/bag/);
  });
});

describe('materials of a model', () => {
  it('the norms planned with a model travel in its document; a change of grade changes the cement', () => {
    const m25 = { ...n, concreteGrade: 'M25 (1:1:2)', concrete: CONCRETE_MIXES['M25 (1:1:2)'] };
    const res = buildModel({ ...defaultSpec(), openings: [], materialNorms: m25 });
    expect(normsOf(res.document).concreteGrade).toBe('M25 (1:1:2)');
    const m20 = buildModel({ ...defaultSpec(), openings: [] });
    expect(res.summary!.materials!.cement).toBeGreaterThan(m20.summary!.materials!.cement);
    expect(res.summary!.materials!.cement).toBeCloseTo((res.summary!.concrete * 554) / 50, 0);
  });

  it('a model without norms uses the standard ones; bad norms stop the model', () => {
    expect(normsOf(undefined)).toEqual(DEFAULT_MATERIAL_NORMS);
    expect(withNormDefaults({ wastagePct: 3 }).concrete).toEqual(n.concrete);
    expect(buildModel({ ...defaultSpec(), materialNorms: { ...n, wastagePct: -1 } }).errors[0]).toMatch(/Wastage/);
  });

  it('per element type: planned from the model, used from approved work only', () => {
    const doc = buildModel({ ...defaultSpec(), openings: [] }).document!;
    const elements = doc.elements.map((e) => ({ ...e, key: e.id })) as unknown as ElementRecord[];
    const footing = elements.find((e) => e.type === 'footing')!;
    const entry = (status: ProgressEntry['status'], quantity: number) =>
      ({ elementId: footing.id, activityCode: 'CONC', unit: 'm3', quantity, status }) as ProgressEntry;
    const entries = [entry('Approved', 0.2), entry('Submitted', 0.3)];
    expect(approvedOf(footing, entries)).toEqual({ CONC: 0.2 });
    const all = projectMaterials(elements, entries, n);
    const row = all.rows.find((r) => r.type === 'footing')!;
    expect(row.count).toBe(4);
    expect(row.used.cement).toBeCloseTo((0.2 * 403) / 50);
    expect(all.used.cement).toBeCloseTo(row.used.cement);
    expect(all.planned.steel).toBeGreaterThan(0);
  });
});

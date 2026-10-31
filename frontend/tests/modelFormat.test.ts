import { describe, expect, it } from 'vitest';
import cabinA from '../src/data/samples/security-cabin-a.json';
import { validateModelDocument } from '../src/domain/modelValidation';

type El = { id: string; type: string; plannedQuantities: Record<string, { quantity: number }>; steelByDia?: unknown; concreteGrade?: unknown };
const withColumn = (patch: Partial<El>) => {
  const doc = structuredClone(cabinA) as unknown as { elements: El[] };
  const col = doc.elements.find((e) => e.type === 'column')!;
  Object.assign(col, patch);
  return { doc, col };
};

describe('model upload: BBS steel by bar size and concrete grade per element', () => {
  it('accepts steelByDia and concreteGrade', () => {
    const { doc, col } = withColumn({});
    const kg = col.plannedQuantities.REINF.quantity;
    Object.assign(col, { steelByDia: { 8: kg * 0.25, 16: kg * 0.75 }, concreteGrade: 'M25' });
    const v = validateModelDocument(doc);
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => /steelByDia/.test(w))).toBe(false);
  });

  it('warns when the BBS does not add up to the planned reinforcement', () => {
    const { doc } = withColumn({ steelByDia: { 8: 1, 12: 2 } });
    const v = validateModelDocument(doc);
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => /steelByDia adds up to 3 kg/.test(w))).toBe(true);
  });

  it('rejects bad bar sizes, negative kg and a bad grade', () => {
    const { doc } = withColumn({ steelByDia: { 5: 2, 12: -1, abc: 3 }, concreteGrade: '' });
    const errs = validateModelDocument(doc).errors.join('\n');
    expect(errs).toMatch(/bar diameter "5"/);
    expect(errs).toMatch(/bar diameter "abc"/);
    expect(errs).toMatch(/steelByDia\["12"\] must be a number of kg/);
    expect(errs).toMatch(/concreteGrade/);
  });
});

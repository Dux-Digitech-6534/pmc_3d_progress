import { describe, expect, it } from 'vitest';
import { cleanConcreteSettings, gradeOf, mixOf } from '../src/domain/concrete';
import { requestNeeds } from '../src/domain/materialRequest';
import { materialRequired } from '../src/domain/materialRequired';
import { CONCRETE_MIXES, withNormDefaults } from '../src/domain/materials';
import type { ElementRecord } from '../src/domain/types';

const norms = withNormDefaults(undefined); // every type M20
const F1 = { id: 'F1', code: 'F1', type: 'footing', concreteGrade: 'M25', plannedQuantities: { CONC: { quantity: 2, unit: 'm3' } } } as unknown as ElementRecord;
const S1 = { id: 'S1', code: 'S1', type: 'slab', plannedQuantities: { CONC: { quantity: 1, unit: 'm3' }, REINF: { quantity: 100, unit: 'kg' } } } as unknown as ElementRecord;

describe('concrete settings', () => {
  it('keeps only known modes and grades', () => {
    expect(cleanConcreteSettings({ mode: 'x', gradeByType: { slab: 'M25', beam: 'M99', wall: 'M20' } })).toEqual({ mode: 'rmc', gradeByType: { slab: 'M25' } });
    expect(cleanConcreteSettings(null)).toEqual({ mode: 'rmc', gradeByType: {} });
  });

  it('the grade chosen in the app wins over the BOQ, then the planning grade', () => {
    expect(gradeOf(F1, norms, { mode: 'rmc', gradeByType: {} })).toBe('M25');
    expect(gradeOf(F1, norms, { mode: 'rmc', gradeByType: { footing: 'M30' } })).toBe('M30');
    expect(gradeOf(S1, norms, { mode: 'rmc', gradeByType: {} })).toBe('M20');
  });

  it('site mix uses the mix of each grade', () => {
    expect(mixOf('M25', norms)).toEqual(CONCRETE_MIXES['M25 (1:1:2)']);
    expect(mixOf('M20', norms)).toEqual(norms.concrete);
    expect(mixOf('M40', norms)).toEqual(norms.concrete); // no nominal mix known: the planning's mix
  });

  it('RMC asks concrete by grade; site mix asks cement, sand and gitti instead', () => {
    const settings = { mode: 'rmc' as const, gradeByType: { slab: 'M25' } };
    const req = materialRequired([F1, S1], [], norms, 'planned', settings);
    expect(req.concrete).toEqual([{ grade: 'M25', m3: 3, elements: 2 }]);
    expect(requestNeeds(req, 'rmc').map((n) => n.key)).toEqual(['steel:8', 'steel:10', 'concrete:M25']);
    const site = requestNeeds(req, 'site');
    expect(site.map((n) => n.key)).toEqual(['steel:8', 'steel:10', 'cement', 'sand', 'aggregate']);
    // 3 m³ of M25 at 554 kg per m³, 50 kg bags
    expect(site.find((n) => n.key === 'cement')?.qty).toBeCloseTo((3 * 554) / 50, 5);
  });
});

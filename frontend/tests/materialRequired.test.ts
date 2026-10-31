import { describe, expect, it } from 'vitest';
import { materialRequired } from '../src/domain/materialRequired';
import { normErrors, withNormDefaults } from '../src/domain/materials';
import type { ElementRecord, ProgressEntry } from '../src/domain/types';

const el = (id: string, type: string, q: Record<string, [number, string]>) =>
  ({ id, code: id, type, plannedQuantities: Object.fromEntries(Object.entries(q).map(([k, [quantity, unit]]) => [k, { quantity, unit }])) }) as unknown as ElementRecord;
const approved = (elementId: string, activityCode: string, quantity: number, unit: string) =>
  ({ id: `${elementId}-${activityCode}`, elementId, activityCode, quantity, unit, status: 'Approved' }) as ProgressEntry;

const norms = withNormDefaults({
  gradeByType: { footing: 'M20', column: 'M25', beam: 'M25', slab: 'M25', lintel: 'M20', chhajja: 'M20' },
  steelSplit: { footing: { 12: 100 }, column: { 8: 20, 16: 80 }, beam: { 8: 25, 12: 75 }, slab: { 8: 40, 10: 60 }, lintel: { 8: 100 }, chhajja: { 8: 100 } },
});

const F1 = el('F1', 'footing', { CONC: [1, 'm3'], REINF: [50, 'kg'], SHUT: [4, 'm2'] });
const C1 = el('C1', 'column', { CONC: [0.2, 'm3'], REINF: [30, 'kg'] });
const S1 = el('S1', 'slab', { CONC: [2, 'm3'], REINF: [100, 'kg'] });
const W1 = el('W1', 'wall', { BRICK: [3, 'm3'], PLAST: [20, 'm2'] });

describe('materialRequired', () => {
  it('splits steel by bar size per element type and adds them up', () => {
    const r = materialRequired([F1, C1, S1], [], norms, 'planned');
    expect(r.steel).toEqual([
      { dia: 8, kg: 46 }, // 6 (column) + 40 (slab)
      { dia: 10, kg: 60 },
      { dia: 12, kg: 50 },
      { dia: 16, kg: 24 },
    ]);
    expect(r.steelTotal).toBe(180);
  });

  it('groups concrete by the grade of each element type', () => {
    const r = materialRequired([F1, C1, S1], [], norms, 'planned');
    expect(r.concrete).toEqual([
      { grade: 'M25', m3: 2.2, elements: 2 },
      { grade: 'M20', m3: 1, elements: 1 },
    ]);
  });

  it('"work still to do" leaves out approved work', () => {
    const r = materialRequired([F1, S1], [approved('S1', 'REINF', 100, 'kg'), approved('S1', 'CONC', 0.5, 'm3')], norms, 'balance');
    expect(r.steel).toEqual([{ dia: 12, kg: 50 }]);
    expect(r.concrete.find((c) => c.grade === 'M25')?.m3).toBe(1.5);
  });

  it('counts brickwork and plaster of walls, and adds wastage', () => {
    const r = materialRequired([W1, F1], [], withNormDefaults({ ...norms, wastagePct: 10 }), 'planned');
    expect(r.brickworkM3).toBe(3.3);
    expect(r.plasterM2).toBe(22);
    expect(r.shutteringM2).toBe(4);
    expect(r.steel).toEqual([{ dia: 12, kg: 55 }]);
    expect(r.materials.bricks).toBeCloseTo(3 * 500 * 1.1);
  });

  it('shows steel with no bar split as "size not set" (dia 0)', () => {
    const r = materialRequired([F1], [], withNormDefaults({ ...norms, steelSplit: { ...norms.steelSplit, footing: {} } }), 'planned');
    expect(r.steel).toEqual([{ dia: 0, kg: 50 }]);
  });
});

describe('material norms: grades and bar sizes', () => {
  it('a model planned before grades by type gets its own grade on every type', () => {
    const n = withNormDefaults({ concreteGrade: 'M25 (1:1:2)' });
    expect(n.gradeByType.slab).toBe('M25');
    expect(n.steelSplit.column).toEqual({ 8: 20, 12: 40, 16: 40 });
  });
  it('the default bar mixes add up to 100 %', () => {
    expect(normErrors(withNormDefaults(undefined))).toEqual([]);
  });
  it('a bar mix that does not add up to 100 % is an error', () => {
    const n = withNormDefaults({ steelSplit: { ...withNormDefaults(undefined).steelSplit, beam: { 8: 25, 12: 50 } } });
    expect(normErrors(n)).toContain('Steel bar sizes for beam must add up to 100 %.');
  });
});

describe('materialRequired with the BBS and grade of uploaded elements', () => {
  const B1 = { ...el('B1', 'beam', { CONC: [0.5, 'm3'], REINF: [40, 'kg'] }), concreteGrade: 'M30', steelByDia: { 8: 10, 20: 30 } } as ElementRecord;

  it('uses the element BBS and grade instead of the typical mix', () => {
    const r = materialRequired([B1, F1], [], norms, 'planned');
    expect(r.steel).toEqual([
      { dia: 8, kg: 10 },
      { dia: 12, kg: 50 },
      { dia: 20, kg: 30 },
    ]);
    expect(r.steelSource).toBe('mixed');
    expect(r.concrete.map((c) => c.grade)).toEqual(['M20', 'M30']);
  });

  it('scales the BBS to the work still to do', () => {
    const r = materialRequired([B1], [approved('B1', 'REINF', 20, 'kg')], norms, 'balance');
    expect(r.steel).toEqual([
      { dia: 8, kg: 5 },
      { dia: 20, kg: 15 },
    ]);
    expect(r.steelSource).toBe('bbs');
  });
});

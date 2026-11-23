import { describe, expect, it } from 'vitest';
import { materialRequired } from '../src/domain/materialRequired';
import { materialsFor, withNormDefaults } from '../src/domain/materials';
import { inItemUnit, requestNeeds, suggestItem } from '../src/domain/materialRequest';
import type { ElementRecord } from '../src/domain/types';

const norms = withNormDefaults({ steelSplit: { ...withNormDefaults(undefined).steelSplit, slab: { 8: 40, 10: 60 } } });
const slab = { id: 'S1', code: 'S1', type: 'slab', concreteGrade: 'M25', plannedQuantities: { CONC: { quantity: 2, unit: 'm3' }, REINF: { quantity: 300, unit: 'kg' } } } as unknown as ElementRecord;
const wall = { id: 'W1', code: 'W1', type: 'wall', plannedQuantities: { BRICK: { quantity: 1, unit: 'm3' }, PLAST: { quantity: 10, unit: 'm2' } } } as unknown as ElementRecord;
const req = materialRequired([slab, wall], [], norms, 'planned');
const items = [
  { code: 'TMT-08', name: 'TMT Bar 8 mm', uom: 'Kg' },
  { code: 'TMT-10', name: 'TMT Bar 10 mm', uom: 'MT' },
  { code: 'OPC', name: 'OPC 53 Cement', uom: 'Bag' },
  { code: 'SAND-KG', name: 'River Sand', uom: 'Kg' },
  { code: 'SAND', name: 'River Sand (cft)', uom: 'Cft' },
  { code: 'D', name: 'Diesel', uom: 'Litre' },
  { code: 'RMC-M20', name: 'RMC M20', uom: 'Cubic Meter' },
  { code: 'RMC-M25', name: 'Ready Mix Concrete M25', uom: 'Cubic Meter' },
  { code: 'BRK', name: 'Red Bricks', uom: 'Nos' },
];

describe('Material Request from the material required', () => {
  it('lists steel per bar size, concrete by grade in m³ (no cement / sand / gitti for it), and cement, sand, bricks of walls and plaster', () => {
    const w = materialsFor({ BRICK: 1, PLAST: 10 }, norms);
    expect(requestNeeds(req).map((n) => [n.key, n.qty])).toEqual([
      ['steel:8', 120],
      ['steel:10', 180],
      ['concrete:M25', 2],
      ['cement', w.cement],
      ['sand', w.sand],
      ['bricks', w.bricks],
    ]);
    expect(requestNeeds(req).find((n) => n.kind === 'concrete')?.label).toBe('Concrete M25');
  });

  it('suggests the ERP item of the same material and bar size, skipping units it cannot convert', () => {
    const needs = requestNeeds(req);
    expect(needs.map((n) => suggestItem(n, items, 50)?.code)).toEqual(['TMT-08', 'TMT-10', 'RMC-M25', 'OPC', 'SAND', 'BRK']);
  });

  it('converts to the item unit, rounding up', () => {
    const [s8, s10, , cement, sand] = requestNeeds(req);
    expect(inItemUnit(s8, 'Kg', 50)).toBe(120);
    expect(inItemUnit(s10, 'MT', 50)).toBe(0.18);
    expect(inItemUnit(cement, 'Bag', 50)).toBe(Math.ceil(req.nonConcrete.cement));
    expect(inItemUnit(sand, 'Cft', 50)).toBeGreaterThan(9);
    expect(inItemUnit(sand, 'Kg', 50)).toBeNull();
  });
});

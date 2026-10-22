import { describe, expect, it } from 'vitest';
import { equalSplit, resolveBatchQuantities, sumQty, validateAllocation } from '../src/domain/allocation';

describe('equalSplit', () => {
  it('splits exactly and keeps the sum equal to the total', () => {
    expect(equalSplit(12, 6)).toEqual([2, 2, 2, 2, 2, 2]);
    const parts = equalSplit(1, 3);
    expect(parts).toEqual([0.334, 0.333, 0.333]);
    expect(sumQty(parts)).toBe(1);
  });

  it('handles awkward totals without drift', () => {
    for (const [total, n] of [[2.304, 4], [10, 7], [0.01, 3], [123.457, 9]] as const) {
      expect(sumQty(equalSplit(total, n))).toBe(total);
    }
  });

  it('rejects totals too small to split and invalid inputs', () => {
    expect(() => equalSplit(0.002, 3)).toThrow(/too small/);
    expect(() => equalSplit(0, 3)).toThrow();
    expect(() => equalSplit(-1, 3)).toThrow();
    expect(() => equalSplit(1, 0)).toThrow();
  });
});

describe('validateAllocation', () => {
  it('accepts allocations matching the total', () => {
    expect(validateAllocation(12, [5, 4, 3]).ok).toBe(true);
  });

  it('rejects allocations that do not add up', () => {
    const r = validateAllocation(12, [5, 4, 2]);
    expect(r.ok).toBe(false);
    expect(r.difference).toBe(1);
    expect(r.errors.join(' ')).toMatch(/does not match/);
  });

  it('rejects zero, negative and over-precise rows', () => {
    expect(validateAllocation(1, [1, 0]).ok).toBe(false);
    expect(validateAllocation(1, [1.5, -0.5]).ok).toBe(false);
    expect(validateAllocation(1, [0.5005, 0.4995]).ok).toBe(false);
  });
});

describe('resolveBatchQuantities — never multiplies a total', () => {
  const six = ['F-01', 'F-02', 'F-03', 'F-04', 'F-05', 'F-06'];

  it('total mode: 12 m³ over 6 footings records 12 m³ in total, not 72 m³', () => {
    const alloc = Object.fromEntries(six.map((id, i) => [id, equalSplit(12, 6)[i]]));
    const r = resolveBatchQuantities('total', 12, six, alloc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(sumQty(Object.values(r.quantities))).toBe(12);
  });

  it('total mode without an allocation is rejected instead of copying the total', () => {
    const r = resolveBatchQuantities('total', 12, six);
    expect(r.ok).toBe(false);
  });

  it('total mode with an allocation that copies the total onto every element is rejected', () => {
    const copied = Object.fromEntries(six.map((id) => [id, 12]));
    const r = resolveBatchQuantities('total', 12, six, copied);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/Allocated 72 does not match the entered total 12/);
  });

  it('per-element mode gives each element the entered value (explicitly chosen)', () => {
    const r = resolveBatchQuantities('per-element', 2, six);
    expect(r.ok).toBe(true);
    if (r.ok) expect(sumQty(Object.values(r.quantities))).toBe(12);
  });

  it('rejects missing rows, extra rows and duplicate selections', () => {
    expect(resolveBatchQuantities('total', 2, ['A', 'B'], { A: 2 }).ok).toBe(false);
    expect(resolveBatchQuantities('total', 2, ['A'], { A: 1, Z: 1 }).ok).toBe(false);
    expect(resolveBatchQuantities('per-element', 1, ['A', 'A']).ok).toBe(false);
    expect(resolveBatchQuantities('per-element', -1, ['A']).ok).toBe(false);
  });
});

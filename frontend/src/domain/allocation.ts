import { QTY_EPSILON, roundQty } from './progress';

/** Quantities are stored with at most this many decimals. */
export const QTY_DECIMALS = 3;

export type QuantityMode = 'total' | 'per-element';

/**
 * Split a total equally across n elements in steps of 10^-decimals.
 * The remainder goes one step at a time to the first elements so the parts always sum
 * to exactly the total (e.g. 1 m³ over 3 → 0.334 + 0.333 + 0.333).
 */
export function equalSplit(total: number, n: number, decimals = QTY_DECIMALS): number[] {
  if (!Number.isInteger(n) || n <= 0) throw new Error('Number of elements must be a positive integer.');
  if (!Number.isFinite(total) || total <= 0) throw new Error('Total quantity must be greater than zero.');
  const f = 10 ** decimals;
  const totalUnits = Math.round(total * f);
  const base = Math.floor(totalUnits / n);
  const remainder = totalUnits - base * n;
  if (base === 0) {
    throw new Error(`Total ${total} is too small to split across ${n} elements at ${decimals} decimals.`);
  }
  return Array.from({ length: n }, (_, i) => (base + (i < remainder ? 1 : 0)) / f);
}

export function sumQty(values: number[]) {
  return roundQty(values.reduce((a, b) => a + b, 0), QTY_DECIMALS);
}

export interface AllocationCheck {
  ok: boolean;
  errors: string[];
  allocated: number;
  difference: number;
}

/** Validate a manual or equal allocation of an entered total across the selected elements. */
export function validateAllocation(total: number, allocations: number[]): AllocationCheck {
  const errors: string[] = [];
  if (!Number.isFinite(total) || total <= 0) errors.push('Enter a total quantity greater than zero.');
  allocations.forEach((q, i) => {
    if (!Number.isFinite(q)) errors.push(`Row ${i + 1}: allocation is not a number.`);
    else if (q < 0) errors.push(`Row ${i + 1}: allocation cannot be negative.`);
    else if (q === 0) errors.push(`Row ${i + 1}: allocation is zero — remove that element from the selection instead.`);
    else if (roundQty(q, QTY_DECIMALS) !== q) errors.push(`Row ${i + 1}: use at most ${QTY_DECIMALS} decimals.`);
  });
  const allocated = sumQty(allocations.filter(Number.isFinite));
  const difference = roundQty(total - allocated, QTY_DECIMALS);
  if (Number.isFinite(total) && Math.abs(difference) > QTY_EPSILON) {
    errors.push(
      `Allocated ${allocated} does not match the entered total ${total} (difference ${difference > 0 ? '+' : ''}${difference}).`,
    );
  }
  return { ok: errors.length === 0, errors, allocated, difference };
}

/**
 * Resolve the per-element quantities for a multi-element entry.
 *  - per-element: every element gets exactly `value` (the user said "per element").
 *  - total: `allocations` must be supplied and must sum to `value`. A total is NEVER copied
 *    onto each element.
 */
export function resolveBatchQuantities(
  mode: QuantityMode,
  value: number,
  elementIds: string[],
  allocations?: Record<string, number>,
): { ok: true; quantities: Record<string, number> } | { ok: false; errors: string[] } {
  if (elementIds.length === 0) return { ok: false, errors: ['Select at least one element.'] };
  if (new Set(elementIds).size !== elementIds.length) return { ok: false, errors: ['The selection contains duplicates.'] };

  if (mode === 'per-element') {
    if (!Number.isFinite(value) || value <= 0) return { ok: false, errors: ['Enter a quantity per element greater than zero.'] };
    if (roundQty(value, QTY_DECIMALS) !== value) return { ok: false, errors: [`Use at most ${QTY_DECIMALS} decimals.`] };
    return { ok: true, quantities: Object.fromEntries(elementIds.map((id) => [id, value])) };
  }

  if (!allocations) return { ok: false, errors: ['Allocate the total across the selected elements (manually or by an equal split).'] };
  const extra = Object.keys(allocations).filter((id) => !elementIds.includes(id));
  if (extra.length) return { ok: false, errors: [`Allocation contains elements that are not selected: ${extra.join(', ')}.`] };
  const missing = elementIds.filter((id) => allocations[id] === undefined);
  if (missing.length) return { ok: false, errors: [`No allocation entered for: ${missing.join(', ')}.`] };

  const check = validateAllocation(value, elementIds.map((id) => allocations[id]));
  if (!check.ok) return { ok: false, errors: check.errors };
  return { ok: true, quantities: Object.fromEntries(elementIds.map((id) => [id, allocations[id]])) };
}

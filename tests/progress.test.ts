import { describe, expect, it } from 'vitest';
import { computeActivityProgress, summarizeActivity } from '../src/domain/progress';
import type { ActivityDef, ElementRecord, ProgressEntry } from '../src/domain/types';

const CONC: ActivityDef = { code: 'CONC', name: 'Concreting', unit: 'm3' };
const REINF: ActivityDef = { code: 'REINF', name: 'Reinforcement', unit: 'kg' };

const el = (id: string, planned: Record<string, { quantity: number; unit: 'm3' | 'kg' | 'm2' }>) =>
  ({ id, code: id, plannedQuantities: planned }) as unknown as ElementRecord;

let seq = 0;
const entry = (p: Partial<ProgressEntry>): ProgressEntry =>
  ({
    id: `E${++seq}`,
    elementId: 'C-01',
    activityCode: 'CONC',
    unit: 'm3',
    quantity: 1,
    status: 'Approved',
    ...p,
  }) as ProgressEntry;

describe('computeActivityProgress', () => {
  const c01 = el('C-01', { CONC: { quantity: 2, unit: 'm3' } });

  it('computes approved / planned × 100 (guide example: 0.4 + 0.8 of 2.0 = 60%)', () => {
    const p = computeActivityProgress(c01, CONC, [entry({ quantity: 0.4 }), entry({ quantity: 0.8 })]);
    expect(p.approved).toBe(1.2);
    expect(p.remaining).toBe(0.8);
    expect(p.percent).toBe(60);
    expect(p.status).toBe('in-progress');
  });

  it('ignores Draft, Submitted and Returned entries for approved totals', () => {
    const p = computeActivityProgress(c01, CONC, [
      entry({ quantity: 0.5, status: 'Draft' }),
      entry({ quantity: 0.6, status: 'Submitted' }),
      entry({ quantity: 0.7, status: 'Returned' }),
    ]);
    expect(p.approved).toBe(0);
    expect(p.pendingReview).toBe(0.6);
    expect(p.draft).toBe(0.5);
    expect(p.status).toBe('not-started');
    expect(p.percent).toBe(0);
  });

  it('marks complete when approved reaches planned', () => {
    const p = computeActivityProgress(c01, CONC, [entry({ quantity: 1.2 }), entry({ quantity: 0.8 })]);
    expect(p.status).toBe('complete');
    expect(p.percent).toBe(100);
    expect(p.remaining).toBe(0);
  });

  it('treats missing or zero planned quantity as Not configured (no percentage)', () => {
    expect(computeActivityProgress(el('X', {}), CONC, []).status).toBe('not-configured');
    const zero = computeActivityProgress(el('X', { CONC: { quantity: 0, unit: 'm3' } }), CONC, []);
    expect(zero.status).toBe('not-configured');
    expect(zero.percent).toBeNull();
  });

  it('treats a planned quantity in the wrong unit as Not configured', () => {
    const p = computeActivityProgress(el('C-01', { CONC: { quantity: 2, unit: 'kg' } }), CONC, [entry({})]);
    expect(p.status).toBe('not-configured');
  });

  it('ignores entries in a different unit, negative or non-finite quantities, and other activities/elements', () => {
    const p = computeActivityProgress(c01, CONC, [
      entry({ quantity: 1, unit: 'kg' }),
      entry({ quantity: -1 }),
      entry({ quantity: Number.NaN }),
      entry({ quantity: 1, activityCode: 'REINF', unit: 'kg' }),
      entry({ quantity: 1, elementId: 'C-02' }),
      entry({ quantity: 0.5 }),
    ]);
    expect(p.approved).toBe(0.5);
  });

  it('avoids floating point drift (0.1 + 0.2)', () => {
    const p = computeActivityProgress(el('C-01', { CONC: { quantity: 0.3, unit: 'm3' } }), CONC, [
      entry({ quantity: 0.1 }),
      entry({ quantity: 0.2 }),
    ]);
    expect(p.approved).toBe(0.3);
    expect(p.status).toBe('complete');
  });
});

describe('summarizeActivity', () => {
  it('sums only within one activity/unit and counts statuses', () => {
    const els = [
      el('F-01', { CONC: { quantity: 1, unit: 'm3' }, REINF: { quantity: 80, unit: 'kg' } }),
      el('F-02', { CONC: { quantity: 1, unit: 'm3' } }),
      el('F-03', {}),
    ];
    const entries = [
      entry({ elementId: 'F-01', quantity: 1 }),
      entry({ elementId: 'F-02', quantity: 0.5 }),
      entry({ elementId: 'F-01', activityCode: 'REINF', unit: 'kg', quantity: 40 }),
    ];
    const conc = summarizeActivity(els, CONC, entries);
    expect(conc.planned).toBe(2);
    expect(conc.approved).toBe(1.5);
    expect(conc.percent).toBe(75);
    expect(conc.counts).toEqual({ complete: 1, 'in-progress': 1, 'not-started': 0, 'not-configured': 1, 'not-applicable': 0 });

    const reinf = summarizeActivity(els, REINF, entries);
    expect(reinf.planned).toBe(80);
    expect(reinf.approved).toBe(40);
    expect(reinf.counts['not-configured']).toBe(2);
  });
});

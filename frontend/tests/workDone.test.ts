import { describe, expect, it } from 'vitest';
import { validateAllocation } from '../src/domain/allocation';
import { markedPercent, planWorkDone } from '../src/domain/workDone';
import type { ActivityDef, ElementRecord, ProgressEntry } from '../src/domain/types';

const CONC: ActivityDef = { code: 'CONC', name: 'Concreting', unit: 'm3', appliesTo: ['footing', 'column', 'beam', 'slab'] };

const el = (id: string, type: string, conc?: number) =>
  ({ id, code: id, type, plannedQuantities: conc === undefined ? {} : { CONC: { quantity: conc, unit: 'm3' } } }) as unknown as ElementRecord;

let seq = 0;
const entry = (elementId: string, quantity: number, status: ProgressEntry['status'] = 'Approved') =>
  ({ id: `E${++seq}`, elementId, activityCode: 'CONC', unit: 'm3', quantity, status }) as ProgressEntry;

describe('planWorkDone', () => {
  const c1 = el('C1', 'column', 0.4);
  const c2 = el('C2', 'column', 0.6);

  it('100% records each element’s full planned quantity', () => {
    const p = planWorkDone([c1, c2], CONC, [], 100);
    expect(p.recording.map((r) => r.quantity)).toEqual([0.4, 0.6]);
    expect(p.total).toBe(1);
  });

  it('records only what is not yet approved or awaiting approval', () => {
    const p = planWorkDone([c1, c2], CONC, [entry('C1', 0.1), entry('C2', 0.3, 'Submitted')], 100);
    expect(p.recording.map((r) => r.quantity)).toEqual([0.3, 0.3]);
  });

  it('50% then 100% records the two halves', () => {
    const half = planWorkDone([c1], CONC, [], 50);
    expect(half.total).toBe(0.2);
    const rest = planWorkDone([c1], CONC, [entry('C1', 0.2, 'Submitted')], 100);
    expect(rest.total).toBe(0.2);
  });

  it('skips elements already marked that far, not configured, or not applicable', () => {
    const wall = el('W1', 'wall', 2);
    const bare = el('C3', 'column');
    const p = planWorkDone([c1, c2, bare, wall], CONC, [entry('C1', 0.4)], 100);
    expect(p.rows.map((r) => r.skip)).toEqual(['already-done', undefined, 'not-configured', 'not-applicable']);
    expect(p.recording.map((r) => r.element.id)).toEqual(['C2']);
  });

  it('never records more than the planned quantity', () => {
    expect(planWorkDone([c1], CONC, [], 250).total).toBe(0.4);
  });

  it('gives allocations that sum exactly to the total (what the server checks)', () => {
    const els = [el('A', 'slab', 1.234), el('B', 'slab', 2.345), el('C', 'slab', 0.333)];
    const p = planWorkDone(els, CONC, [entry('A', 0.111)], 75);
    expect(validateAllocation(p.total, p.recording.map((r) => r.quantity)).ok).toBe(true);
  });
});

describe('markedPercent', () => {
  it('counts approved and awaiting work, capped at 100', () => {
    const c = el('C1', 'column', 0.4);
    expect(markedPercent(c, CONC, [])).toBe(0);
    expect(markedPercent(c, CONC, [entry('C1', 0.1), entry('C1', 0.1, 'Submitted')])).toBe(50);
    expect(markedPercent(c, CONC, [entry('C1', 0.5)])).toBe(100);
    expect(markedPercent(el('X', 'column'), CONC, [])).toBeNull();
  });
});

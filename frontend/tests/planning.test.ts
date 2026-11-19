import { describe, expect, it } from 'vitest';
import { LocalRepository, MemoryStorage } from '../src/data/localRepository';
import { seedDemoData } from '../src/data/seed';
import { completeDateOf, countResults, daysTaken, planVsActual, type PlanningData } from '../src/domain/planning';
import type { ActivityDef, ElementRecord, ProgressEntry } from '../src/domain/types';

const CONC = { code: 'CONC', name: 'Concreting', unit: 'm3' } as ActivityDef;
const el = (id: string) => ({ id, code: id, type: 'footing', buildingName: 'B', levelName: 'L', plannedQuantities: { CONC: { quantity: 2, unit: 'm3' } } }) as unknown as ElementRecord;
const en = (elementId: string, date: string, quantity: number, status: ProgressEntry['status'] = 'Submitted') =>
  ({ elementId, activityCode: 'CONC', date, quantity, status, unit: 'm3' }) as ProgressEntry;

describe('plan vs actual', () => {
  const data: PlanningData = {
    plans: [
      { id: 'p1', elementId: 'F1', activityCode: 'CONC', date: '2026-11-10' }, // 1.5 of 2 m³ on the 10th: not finished, date over
      { id: 'p2', elementId: 'F2', activityCode: 'CONC', date: '2026-11-10' }, // only marked started
      { id: 'p3', elementId: 'F3', activityCode: 'CONC', date: '2026-11-10', noWork: { reason: 'Rain' } },
      { id: 'p4', elementId: 'F4', activityCode: 'CONC', date: '2026-11-10' }, // finished on the 11th: 1 day late
      { id: 'p5', elementId: 'F5', activityCode: 'CONC', date: '2026-11-19' }, // today: still planned
      { id: 'p6', elementId: 'F6', activityCode: 'CONC', date: '2026-11-10' }, // only a draft: not reported
      { id: 'p7', elementId: 'F7', activityCode: 'CONC', date: '2026-11-10', to: '2026-11-12' }, // finished on the 11th: on time
      { id: 'p8', elementId: 'F8', activityCode: 'CONC', date: '2026-11-15', to: '2026-11-25' }, // started, To not over
    ],
    starts: [
      { elementId: 'F2', activityCode: 'CONC', date: '2026-11-10' },
      { elementId: 'F8', activityCode: 'CONC', date: '2026-11-16' },
    ],
  };
  const entries = [en('F1', '2026-11-10', 1.5), en('F6', '2026-11-10', 1, 'Draft'), en('F4', '2026-11-11', 2), en('F7', '2026-11-11', 2, 'Approved')];
  const els = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'].map(el);

  it('On time / Late / Going on / No work / Not reported / Planned, with the real start and finish', () => {
    const rows = planVsActual(data, entries, els, [CONC], '2026-11-19');
    const by = Object.fromEntries(rows.map((r) => [r.plan.id, r]));
    expect(Object.fromEntries(rows.map((r) => [r.plan.id, r.result]))).toEqual({
      p1: 'late',
      p2: 'late',
      p3: 'no-work',
      p4: 'late',
      p5: 'pending',
      p6: 'missed', // a draft is not reported work
      p7: 'done',
      p8: 'started',
    });
    expect(by.p4.actualDone).toBe('2026-11-11');
    expect(by.p4.detail).toBe('Finished 1 day late');
    expect(by.p1.actualStart).toBe('2026-11-10');
    expect(by.p1.detail).toBe('Started, not finished — 9 days past the plan');
    expect(by.p7.detail).toBe('Finished on time');
    expect(by.p8.actualStart).toBe('2026-11-16');
    expect(by.p3.detail).toBe('No work: Rain');
    expect(countResults(rows)).toEqual({ done: 1, late: 3, started: 1, 'no-work': 1, missed: 1, pending: 1 });
  });

  it('a filter keeps the plans that overlap the dates', () => {
    expect(planVsActual(data, entries, els, [CONC], '2026-11-19', '2026-11-12', '2026-11-12').map((r) => r.plan.id)).toEqual(['p7']);
    expect(planVsActual(data, entries, els, [CONC], '2026-11-19', '2026-11-13', '2026-11-30').map((r) => r.plan.id)).toEqual(['p8', 'p5']);
  });
});

describe('complete date and days taken', () => {
  it('complete date = the entry that reaches the planned quantity', () => {
    const e = [en('F1', '2026-11-03', 1, 'Approved'), en('F1', '2026-11-07', 1, 'Submitted'), en('F1', '2026-11-09', 1, 'Draft')];
    expect(completeDateOf(el('F1'), 'CONC', e)).toBe('2026-11-07');
    expect(completeDateOf(el('F1'), 'CONC', e.slice(0, 1))).toBeUndefined();
  });
  it('counts both days', () => {
    expect(daysTaken('2026-11-01', '2026-11-10')).toBe(10);
    expect(daysTaken('2026-11-05', '2026-11-05')).toBe(1);
    expect(daysTaken(undefined, '2026-11-05')).toBeUndefined();
  });
});

describe('planning in the local repository', () => {
  it('add (no double), No work, delete, started — only engineer / reviewer', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage(), seed: seedDemoData });
    const els = await repo.listElements('PMC-SEC-001');
    const footings = els.filter((e) => e.type === 'footing').map((e) => e.id);
    await expect(repo.addPlans('PMC-SEC-001', { date: '2026-12-01', activityCode: 'CONC', elementIds: footings }, 'owner')).rejects.toThrow(/Site Engineer or PMC Reviewer/);
    const a = await repo.addPlans('PMC-SEC-001', { date: '2026-12-01', activityCode: 'CONC', elementIds: footings }, 'site-engineer');
    expect(a.added).toBe(footings.length);
    const b = await repo.addPlans('PMC-SEC-001', { date: '2026-12-01', activityCode: 'CONC', elementIds: footings }, 'site-engineer');
    expect(b.added).toBe(0);
    expect(b.skipped).toBe(footings.length);
    // concreting does not apply to a door or wall
    const wall = els.find((e) => e.type === 'wall');
    if (wall) await expect(repo.addPlans('PMC-SEC-001', { date: '2026-12-01', activityCode: 'CONC', elementIds: [wall.id] }, 'site-engineer')).rejects.toThrow(/does not apply/);

    // a From – To plan; To before From is refused
    const r = await repo.addPlans('PMC-SEC-001', { date: '2026-12-01', to: '2026-12-05', activityCode: 'CONC', elementIds: footings.slice(0, 1) }, 'site-engineer');
    expect(r.added).toBe(1);
    expect(r.plans.at(-1)!.to).toBe('2026-12-05');
    await expect(repo.addPlans('PMC-SEC-001', { date: '2026-12-05', to: '2026-12-01', activityCode: 'CONC', elementIds: footings }, 'site-engineer')).rejects.toThrow(/before/);
    await repo.deletePlans('PMC-SEC-001', [r.plans.at(-1)!.id], 'site-engineer');

    const id = b.plans[0].id;
    let d = await repo.setNoWork('PMC-SEC-001', [id], 'Rain', 'site-engineer');
    expect(d.plans.find((p) => p.id === id)!.noWork!.reason).toBe('Rain');
    d = await repo.setNoWork('PMC-SEC-001', [id], '', 'site-engineer');
    expect(d.plans.find((p) => p.id === id)!.noWork).toBeUndefined();
    d = await repo.deletePlans('PMC-SEC-001', [id], 'site-engineer');
    expect(d.plans).toHaveLength(footings.length - 1);

    d = await repo.markStarted('PMC-SEC-001', footings.slice(0, 2), 'REINF', '2026-01-05', 'site-engineer');
    expect(d.starts).toHaveLength(2);
    d = await repo.markStarted('PMC-SEC-001', footings.slice(0, 1), 'REINF', '2026-01-06', 'site-engineer'); // a new date replaces it
    expect(d.starts.filter((s) => s.elementId === footings[0]).map((s) => s.date)).toEqual(['2026-01-06']);
    d = await repo.clearStarted('PMC-SEC-001', footings.slice(0, 2), 'REINF', 'site-engineer');
    expect(d.starts).toHaveLength(0);
    await expect(repo.markStarted('PMC-SEC-001', footings, 'REINF', '2999-01-01', 'site-engineer')).rejects.toThrow(/future/);
  });
});

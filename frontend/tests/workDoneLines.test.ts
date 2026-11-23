import { describe, expect, it } from 'vitest';
import { workDoneLines } from '../src/domain/reports';
import type { ActivityDef, ElementRecord, ProgressEntry } from '../src/domain/types';

const acts: ActivityDef[] = [
  { code: 'REINF', name: 'Reinforcement', unit: 'kg' },
  { code: 'CONC', name: 'Concreting', unit: 'm3' },
];
const el = (id: string, type: string, buildingId = 'B1') =>
  ({ id, code: id, type, buildingId, buildingName: 'Block', levelId: 'L0', levelName: 'Ground', plannedQuantities: {} }) as unknown as ElementRecord;
const entry = (elementId: string, activityCode: string, date: string, quantity: number, status: ProgressEntry['status'] = 'Approved', unit = activityCode === 'CONC' ? 'm3' : 'kg') =>
  ({ elementId, activityCode, date, quantity, status, unit, remarks: '' }) as unknown as ProgressEntry;

const elements = [el('F1', 'footing'), el('C1', 'column'), el('X9', 'footing', 'B2')];
const entries = [
  entry('C1', 'CONC', '2026-11-10', 0.2),
  entry('F1', 'CONC', '2026-11-05', 1.1),
  entry('F1', 'REINF', '2026-11-05', 94),
  entry('F1', 'REINF', '2026-11-12', 10, 'Submitted'),
  entry('F1', 'REINF', '2026-11-13', 5, 'Draft'),
  entry('X9', 'CONC', '2026-11-06', 2),
  entry('C1', 'CONC', '2026-10-01', 9),
];

describe('work done for billing', () => {
  it('lists approved entries of the dates, by date, element and work order', () => {
    const l = workDoneLines(elements, entries, acts, { from: '2026-11-01', to: '2026-11-30', mode: 'approved' });
    expect(l.map((x) => [x.date, x.element.id, x.activity.code, x.quantity])).toEqual([
      ['2026-11-05', 'F1', 'REINF', 94],
      ['2026-11-05', 'F1', 'CONC', 1.1],
      ['2026-11-06', 'X9', 'CONC', 2],
      ['2026-11-10', 'C1', 'CONC', 0.2],
    ]);
  });

  it('adds work waiting for approval when asked, never drafts; follows the building and type', () => {
    const l = workDoneLines(elements, entries, acts, { from: '2026-11-01', to: '2026-11-30', mode: 'with-pending', buildingId: 'B1', type: 'footing' });
    expect(l.map((x) => [x.element.id, x.activity.code, x.status])).toEqual([
      ['F1', 'REINF', 'Approved'],
      ['F1', 'CONC', 'Approved'],
      ['F1', 'REINF', 'Submitted'],
    ]);
  });
});

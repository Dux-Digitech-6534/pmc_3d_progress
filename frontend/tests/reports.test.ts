import { describe, expect, it } from 'vitest';
import { categoryStatus, elementLabel, executiveSummary, presetRange } from '../src/domain/reports';
import type { ActivityDef, ElementRecord, ProgressEntry } from '../src/domain/types';

const act = (code: string, name: string, unit: ActivityDef['unit'], appliesTo?: string[]): ActivityDef => ({ code, name, unit, appliesTo }) as ActivityDef;
const REINF = act('REINF', 'Reinforcement', 'kg', ['footing', 'column']);
const SHUT = act('SHUT', 'Shuttering', 'm2', ['footing', 'column']);
const CONC = act('CONC', 'Concreting', 'm3', ['footing', 'column']);
const BRICK = act('BRICK', 'Brickwork', 'm3', ['wall']);
const ACTS = [CONC, REINF, SHUT, BRICK];

const el = (id: string, type: string, building = 'B1', level = 'L0'): ElementRecord =>
  ({
    id,
    code: id,
    type,
    buildingId: building,
    levelId: level,
    buildingName: building === 'B1' ? 'Office' : 'Store',
    levelName: level === 'L0' ? 'Plinth' : 'First Floor',
    plannedQuantities:
      type === 'wall'
        ? { BRICK: { quantity: 2, unit: 'm3' } }
        : type === 'footing' || type === 'column'
          ? { REINF: { quantity: 50, unit: 'kg' }, SHUT: { quantity: 4, unit: 'm2' }, CONC: { quantity: 1, unit: 'm3' } }
          : {},
  }) as unknown as ElementRecord;

const UNIT: Record<string, ProgressEntry['unit']> = { REINF: 'kg', SHUT: 'm2', CONC: 'm3', BRICK: 'm3' };
const en = (elementId: string, activityCode: string, quantity: number, date: string, status: ProgressEntry['status'] = 'Approved') =>
  ({ elementId, activityCode, quantity, date, status, unit: UNIT[activityCode] }) as ProgressEntry;

describe('element label', () => {
  it('building – floor – code', () => {
    expect(elementLabel(el('F1', 'footing'))).toBe('Office – Plinth – F1');
  });
});

describe('date presets', () => {
  const today = new Date(2026, 10, 17);
  it('today, last 10 days (inclusive), this month, all', () => {
    expect(presetRange('today', today)).toEqual({ from: '2026-11-17', to: '2026-11-17' });
    expect(presetRange('last10', today)).toEqual({ from: '2026-11-08', to: '2026-11-17' });
    expect(presetRange('month', today)).toEqual({ from: '2026-11-01', to: '2026-11-17' });
    expect(presetRange('all', today)).toEqual({ from: '', to: '' });
  });
});

describe('executive summary', () => {
  const elements = [el('F1', 'footing'), el('F2', 'footing'), el('C1', 'column', 'B1', 'L1'), el('W1', 'wall', 'B2')];
  const entries = [
    en('F1', 'REINF', 50, '2026-11-10'),
    en('F1', 'CONC', 1, '2026-11-12'),
    en('F2', 'REINF', 20, '2026-11-12'),
    en('C1', 'REINF', 30, '2026-11-15', 'Submitted'),
    en('W1', 'BRICK', 2, '2026-11-01'),
    en('F2', 'SHUT', 4, '2026-11-12', 'Draft'),
    en('F2', 'CONC', 1, '2026-11-12', 'Returned'),
    en('GONE', 'CONC', 5, '2026-11-12'), // element not in the current model
  ];

  it('adds approved work per activity; drafts, returned and unknown elements never count', () => {
    const s = executiveSummary(elements, entries, ACTS, { mode: 'approved' });
    expect(s.totals).toEqual({ REINF: 70, CONC: 1, BRICK: 2 });
    expect(s.activities.map((a) => a.code)).toEqual(['REINF', 'CONC', 'BRICK']);
    expect(s.entries).toBe(4);
    expect(s.days).toBe(3);
    expect(s.elements).toBe(3);
  });

  it('can include work waiting for approval', () => {
    const s = executiveSummary(elements, entries, ACTS, { mode: 'with-pending' });
    expect(s.totals.REINF).toBe(100);
  });

  it('filters by dates (inclusive) and building', () => {
    expect(executiveSummary(elements, entries, ACTS, { mode: 'approved', from: '2026-11-12', to: '2026-11-12' }).totals).toEqual({ CONC: 1, REINF: 20 });
    expect(executiveSummary(elements, entries, ACTS, { mode: 'approved', buildingId: 'B2' }).totals).toEqual({ BRICK: 2 });
  });

  it('splits by building + floor and by element type', () => {
    const s = executiveSummary(elements, entries, ACTS, { mode: 'with-pending' });
    expect(s.byFloor.map((g) => [g.label.join(' / '), g.qty])).toEqual([
      ['Office / Plinth', { REINF: 70, CONC: 1 }],
      ['Office / First Floor', { REINF: 30 }],
      ['Store / Plinth', { BRICK: 2 }],
    ]);
    expect(s.byType.map((g) => [g.label[0], g.qty])).toEqual([
      ['Footing', { REINF: 70, CONC: 1 }],
      ['Column', { REINF: 30 }],
      ['Wall', { BRICK: 2 }],
    ]);
  });
});

describe('category-wise status', () => {
  const elements = ['F1', 'F2', 'F3', 'F4', 'F5'].map((id) => el(id, 'footing')).concat(el('C1', 'column'));
  const entries = [
    // F1 complete
    en('F1', 'REINF', 50, '2026-11-10'),
    en('F1', 'SHUT', 4, '2026-11-10'),
    en('F1', 'CONC', 1, '2026-11-11'),
    // F2 steel done
    en('F2', 'REINF', 50, '2026-11-10'),
    // F3 shuttering half done (steel done)
    en('F3', 'REINF', 50, '2026-11-10'),
    en('F3', 'SHUT', 2, '2026-11-12'),
    // F4 steel sent, waiting for approval
    en('F4', 'REINF', 50, '2026-11-12', 'Submitted'),
  ];

  it('puts each element in the bucket of its furthest work, furthest first', () => {
    const s = categoryStatus(elements, entries, ACTS, 'footing', 'approved');
    expect(s.activities.map((a) => a.code)).toEqual(['REINF', 'SHUT', 'CONC']);
    expect(s.buckets.map((b) => [b.label, b.elements.map((e) => e.id)])).toEqual([
      ['Complete', ['F1']],
      ['Shuttering in progress', ['F3']],
      ['Reinforcement done', ['F2']],
      ['Not started', ['F4', 'F5']],
    ]);
    expect(s.rows.find((r) => r.element.id === 'F3')!.percent).toEqual({ REINF: 100, SHUT: 50, CONC: 0 });
  });

  it('with pending work counted, F4 moves to "Reinforcement done"', () => {
    const s = categoryStatus(elements, entries, ACTS, 'footing', 'with-pending');
    expect(s.buckets.find((b) => b.label === 'Reinforcement done')!.elements.map((e) => e.id)).toEqual(['F2', 'F4']);
  });

  it('elements without planned quantities get their own bucket', () => {
    const s = categoryStatus([el('S1', 'slab')], [], ACTS, 'slab', 'approved');
    expect(s.buckets.map((b) => b.label)).toEqual(['No planned quantity']);
  });
});

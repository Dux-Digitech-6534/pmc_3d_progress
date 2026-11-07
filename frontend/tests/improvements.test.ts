import { describe, expect, it } from 'vitest';
import { LocalRepository, MemoryStorage } from '../src/data/localRepository';
import { seedDemoData } from '../src/data/seed';
import { materialRequired } from '../src/domain/materialRequired';
import { withNormDefaults } from '../src/domain/materials';
import { variationReport } from '../src/domain/materialVariation';
import { inWorkOrder, missingPriorWork, stageOf } from '../src/domain/sequence';
import type { ActivityDef, ElementRecord, ProgressEntry } from '../src/domain/types';

const act = (code: string, name: string, unit: ActivityDef['unit'] = 'm3'): ActivityDef => ({ code, name, unit }) as ActivityDef;
const CONC = act('CONC', 'Concreting');
const REINF = act('REINF', 'Reinforcement', 'kg');
const SHUT = act('SHUT', 'Shuttering', 'm2');
const PLAST = act('PLAST', 'Plaster', 'm2');
const BRICK = act('BRICK', 'Brickwork');

describe('work order', () => {
  it('puts steel and shuttering before the pour, brickwork before plaster', () => {
    expect(inWorkOrder([CONC, PLAST, REINF, BRICK, SHUT]).map((a) => a.code)).toEqual(['REINF', 'SHUT', 'CONC', 'BRICK', 'PLAST']);
    expect(stageOf(act('X', 'Waterproofing'))).toBeGreaterThan(stageOf(PLAST));
  });

  const footing = {
    id: 'F1',
    code: 'F1',
    type: 'footing',
    plannedQuantities: { CONC: { quantity: 1, unit: 'm3' }, REINF: { quantity: 50, unit: 'kg' }, SHUT: { quantity: 2, unit: 'm2' } },
  } as unknown as ElementRecord;
  const entry = (activityCode: string, quantity: number, status: ProgressEntry['status']) =>
    ({ elementId: 'F1', activityCode, quantity, status, unit: activityCode === 'REINF' ? 'kg' : activityCode === 'SHUT' ? 'm2' : 'm3' }) as ProgressEntry;

  it('flags concreting while the steel and shuttering are not reported', () => {
    const miss = missingPriorWork([footing], CONC, [REINF, SHUT, CONC], []);
    expect(miss[0].activities.map((a) => a.code)).toEqual(['REINF', 'SHUT']);
  });

  it('counts approved + submitted work as reported, not drafts or returned', () => {
    const entries = [entry('REINF', 50, 'Approved'), entry('SHUT', 2, 'Submitted')];
    expect(missingPriorWork([footing], CONC, [REINF, SHUT, CONC], entries)).toEqual([]);
    expect(missingPriorWork([footing], CONC, [REINF, SHUT, CONC], [entry('REINF', 50, 'Draft'), entry('SHUT', 2, 'Returned')])).toHaveLength(1);
  });

  it('reinforcement (first stage) never needs earlier work', () => {
    expect(missingPriorWork([footing], REINF, [REINF, SHUT, CONC], [])).toEqual([]);
  });
});

describe('PMC takes an approval back', () => {
  it('Approved -> Returned with the reason; only the reviewer; reason required', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage(), seed: seedDemoData });
    const approved = (await repo.listProgressEntries('PMC-SEC-001')).find((e) => e.status === 'Approved')!;
    await expect(repo.reviewProgressEntry(approved.id, 'reopen', 'x', 'site-engineer')).rejects.toThrow();
    await expect(repo.reviewProgressEntry(approved.id, 'reopen', '  ', 'pmc-reviewer')).rejects.toThrow(/reason/);
    const back = await repo.reviewProgressEntry(approved.id, 'reopen', 'Wrong element', 'pmc-reviewer');
    expect(back.status).toBe('Returned');
    expect(back.reviewRemarks).toBe('Wrong element');
    expect(back.history.at(-1)?.action).toBe('Approval withdrawn');
    // a submitted entry cannot be "taken back"
    const submitted = (await repo.listProgressEntries('PMC-SEC-001')).find((e) => e.status === 'Submitted')!;
    await expect(repo.reviewProgressEntry(submitted.id, 'reopen', 'x', 'pmc-reviewer')).rejects.toThrow(/only an Approved/);
  });
});

describe('material variation settings', () => {
  it('keeps the ERP project per PMC project and the item map', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage(), seed: seedDemoData });
    expect(await repo.getVariationSettings('PMC-SEC-001')).toEqual({ erpProject: '', itemMap: {} });
    await repo.saveVariationSettings('PMC-SEC-001', { erpProject: 'ERP-DEMO' });
    await repo.saveVariationSettings('PMC-SEC-001', { itemMap: { 'ITM-1': { kind: 'steel', dia: 12 } } });
    expect(await repo.getVariationSettings('PMC-SEC-001')).toEqual({ erpProject: 'ERP-DEMO', itemMap: { 'ITM-1': { kind: 'steel', dia: 12 } } });
    expect((await repo.getVariationSettings('PMC-SEC-002')).erpProject).toBe('');
  });

  it('an item set by hand is counted; "ignore" drops it', () => {
    const needed = materialRequired([], [], withNormDefaults(undefined), 'done');
    const lines = [
      { voucher: 'V1', date: '2026-11-01', itemCode: 'ITM-1', itemName: 'Item 4471', qty: 100, uom: 'Kg' },
      { voucher: 'V1', date: '2026-11-01', itemCode: 'ITM-2', itemName: 'Diesel', qty: 40, uom: 'Litre' },
    ];
    const plain = variationReport(lines, needed, withNormDefaults(undefined), 5);
    expect(plain.unmatched.map((u) => u.itemCode)).toEqual(['ITM-1', 'ITM-2']);
    const mapped = variationReport(lines, needed, withNormDefaults(undefined), 5, { 'ITM-1': { kind: 'steel', dia: 12 }, 'ITM-2': 'ignore' });
    expect(mapped.unmatched).toEqual([]);
    expect(mapped.rows.find((r) => r.key === 'steel:12')?.sent).toBe(100);
  });
});

describe('round 3 fixes', () => {
  it('a draft counts as marked, so the same % is not recorded twice', async () => {
    const { planWorkDone, markedPercent } = await import('../src/domain/workDone');
    const wall = { id: 'W1', code: 'W1', type: 'wall', plannedQuantities: { BRICK: { quantity: 1.225, unit: 'm3' } } } as unknown as ElementRecord;
    const BR = act('BRICK', 'Brickwork');
    const draft = { elementId: 'W1', activityCode: 'BRICK', unit: 'm3', quantity: 0.613, status: 'Draft' } as ProgressEntry;
    expect(markedPercent(wall, BR, [draft])).toBe(50);
    expect(planWorkDone([wall], BR, [draft], 50).recording).toHaveLength(0);
    expect(planWorkDone([wall], BR, [draft], 100).total).toBeCloseTo(0.612, 6);
  });

  it('a new revision that drops an element or plans less than reported is listed', async () => {
    const { revisionConflicts } = await import('../src/domain/revisionCheck');
    const current = [
      { id: 'W1', code: 'W1' },
      { id: 'WN', code: 'WN-01' },
    ] as unknown as ElementRecord[];
    const e = (elementId: string, quantity: number, status: ProgressEntry['status'], activityCode = 'BRICK', unit = 'm3') =>
      ({ elementId, activityCode, activityName: activityCode === 'BRICK' ? 'Brickwork' : 'Fixing', unit, quantity, status, modelId: 'M' }) as ProgressEntry;
    const next = {
      model: { id: 'M' },
      activities: [act('BRICK', 'Brickwork'), act('FIX', 'Fixing', 'nos' as ActivityDef['unit'])],
      elements: [{ id: 'W1', plannedQuantities: { BRICK: { quantity: 0.49, unit: 'm3' } } }],
    } as never;
    const out = revisionConflicts(current, [e('W1', 0.613, 'Submitted'), e('WN', 1, 'Approved', 'FIX', 'nos'), e('W1', 5, 'Returned')], next);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/WN-01 is not in the new file/);
    expect(out[1]).toMatch(/W1 Brickwork: 0\.613 m³ already reported, the new plan is only 0\.49 m³/);
    expect(revisionConflicts(current, [e('W1', 0.4, 'Approved')], next)).toEqual([]);
  });
});

describe('ERP project follows the PMC project', () => {
  it('links once and keeps the link', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage(), seed: seedDemoData });
    const a = await repo.ensureErpProject('PMC-SEC-001');
    expect(a.erpProject).toBe('ERP-DEMO');
    expect((await repo.getVariationSettings('PMC-SEC-001')).erpProject).toBe('ERP-DEMO');
    await repo.saveVariationSettings('PMC-SEC-001', { erpProject: 'ERP-X' });
    expect((await repo.ensureErpProject('PMC-SEC-001')).erpProject).toBe('ERP-X');
  });
});

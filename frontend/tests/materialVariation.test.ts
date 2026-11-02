import { describe, expect, it } from 'vitest';
import { materialRequired } from '../src/domain/materialRequired';
import { withNormDefaults } from '../src/domain/materials';
import { matchItem, toReportUnit, variationReport, type SentLine } from '../src/domain/materialVariation';
import type { ElementRecord, ProgressEntry } from '../src/domain/types';

describe('matchItem: which material an ERP item is', () => {
  it.each([
    ['TMT Bar 12 mm Fe500D', { kind: 'steel', dia: 12 }],
    ['Sariya 8mm', { kind: 'steel', dia: 8 }],
    ['TMT Fe 550', { kind: 'steel', dia: 0 }],
    ['OPC 53 Grade Cement', { kind: 'cement' }],
    ['PPC Cement (bag)', { kind: 'cement' }],
    ['River Sand', { kind: 'sand' }],
    ['20 mm Metal', { kind: 'aggregate' }],
    ['Gitti 10mm', { kind: 'aggregate' }],
    ['RMC M25', { kind: 'concrete', grade: 'M25' }],
    ['Ready Mix Concrete', { kind: 'concrete', grade: undefined }],
    ['Red Bricks', { kind: 'bricks' }],
  ])('%s', (name, want) => expect(matchItem(name)).toEqual(want));

  it.each(['Metal Sheet 0.5mm', 'Diesel', 'Paint', 'MDPE Pipe 63mm', 'Collar'])('%s is not a building material here', (name) => expect(matchItem(name)).toBeNull());
});

describe('toReportUnit', () => {
  it('converts the usual stock units', () => {
    expect(toReportUnit('steel', 1.5, 'MT', 50)).toBe(1500);
    expect(toReportUnit('steel', 300, 'Kg', 50)).toBe(300);
    expect(toReportUnit('cement', 500, 'Kg', 50)).toBe(10);
    expect(toReportUnit('cement', 12, 'Bag', 50)).toBe(12);
    expect(toReportUnit('sand', 100, 'Cft', 50)).toBeCloseTo(2.832, 3);
    expect(toReportUnit('sand', 1, 'Brass', 50)).toBeCloseTo(2.832, 3);
  });
  it('gives null when the unit cannot be converted (sand in kg needs a density)', () => {
    expect(toReportUnit('sand', 1000, 'Kg', 50)).toBeNull();
  });
});

const el = (id: string, type: string, q: Record<string, number>) =>
  ({
    id,
    code: id,
    type,
    plannedQuantities: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { quantity: v, unit: k === 'REINF' ? 'kg' : k === 'SHUT' ? 'm2' : 'm3' }])),
  }) as unknown as ElementRecord;
const approved = (elementId: string, activityCode: string, quantity: number) =>
  ({ id: `${elementId}${activityCode}`, elementId, activityCode, quantity, unit: activityCode === 'REINF' ? 'kg' : 'm3', status: 'Approved' }) as ProgressEntry;
const line = (itemName: string, qty: number, uom: string): SentLine => ({ voucher: 'MAT-STE-1', date: '2026-10-30', itemCode: itemName, itemName, qty, uom });

describe('variationReport', () => {
  const norms = withNormDefaults({ steelSplit: { ...withNormDefaults(undefined).steelSplit, slab: { 8: 40, 10: 60 } } });
  const S1 = el('S1', 'slab', { CONC: 2, REINF: 300 });
  // the slab is done: 300 kg of steel should have gone in
  const done = materialRequired([S1], [approved('S1', 'REINF', 300), approved('S1', 'CONC', 2)], norms, 'done');

  it('the meeting example: 300 kg needed, 500 kg sent = 67 % excess; 310 kg = OK within 5 %', () => {
    const big = variationReport([line('TMT 8mm', 120, 'Kg'), line('TMT 10 mm', 0.38, 'MT')], done, norms, 5);
    const steel = big.rows.find((r) => r.key === 'steel')!;
    expect([steel.sent, steel.needed, steel.percent, steel.status]).toEqual([500, 300, 66.7, 'excess']);
    expect(big.rows.find((r) => r.key === 'steel:10')).toMatchObject({ sent: 380, needed: 180, status: 'excess' });

    const ok = variationReport([line('TMT 8mm', 124, 'Kg'), line('TMT 10mm', 186, 'Kg')], done, norms, 5);
    expect(ok.rows.find((r) => r.key === 'steel')).toMatchObject({ sent: 310, percent: 3.3, status: 'ok' });
  });

  it('cement for site-mixed concrete; less sent than needed is "short"', () => {
    const r = variationReport([line('OPC Cement', 10, 'Bag')], done, norms, 5);
    const cement = r.rows.find((x) => x.key === 'cement')!;
    expect(cement.needed).toBeCloseTo((2 * 403) / 50, 1);
    expect(cement.status).toBe('short');
  });

  it('with ready-mix received, the concrete needs no site cement', () => {
    const r = variationReport([line('RMC M20', 2, 'Cum'), line('OPC Cement', 1, 'Bag')], done, norms, 5);
    expect(r.rows.find((x) => x.key === 'concrete:M20')).toMatchObject({ sent: 2, needed: 2, status: 'ok' });
    expect(r.rows.find((x) => x.key === 'cement')).toMatchObject({ needed: 0, status: 'no-work' });
  });

  it('lists items it does not know and units it cannot convert', () => {
    const r = variationReport([line('Diesel', 40, 'Litre'), line('River Sand', 900, 'Kg')], done, norms, 5);
    expect(r.unmatched.map((u) => u.itemName)).toEqual(['Diesel']);
    expect(r.unconvertible).toMatchObject([{ itemName: 'River Sand', uom: 'Kg', unit: 'm³' }]);
  });

  it('nothing sent for done work is "not sent"', () => {
    expect(variationReport([], done, norms, 5).rows.find((r) => r.key === 'steel')?.status).toBe('not-sent');
  });
});

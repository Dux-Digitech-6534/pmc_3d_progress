import { describe, expect, it } from 'vitest';
import { projectStock } from '../src/domain/projectStock';

const items = [
  { code: 'TMT-12', name: 'TMT Bar 12 mm', uom: 'Kg' },
  { code: 'OPC', name: 'OPC 53 Cement', uom: 'Bag' },
  { code: 'DSL', name: 'Diesel', uom: 'Litre' },
];
const projects = [
  { id: 'P2', name: 'Wagholi' },
  { id: 'P1', name: 'Hadapsar' },
];
const mv = (project: string, warehouse: string, itemCode: string, qty: number, uom = 'Kg') => ({ project, warehouse, itemCode, qty, uom, date: '2026-11-01' });
const moves = [
  mv('P1', 'Site A', 'TMT-12', 300),
  mv('P1', 'Site A', 'TMT-12', -120.5),
  mv('P1', 'Site A', 'OPC', 50, 'Bag'),
  mv('P1', 'Site A', 'DSL', 40, 'Litre'),
  mv('P2', 'Store', 'TMT-12', -20),
];

describe('project stock', () => {
  it('adds up received, issued and balance per project, warehouse and item', () => {
    const g = projectStock(moves, items, projects);
    expect(g.map((x) => x.projectName)).toEqual(['Hadapsar', 'Wagholi']);
    const steel = g[0].rows.find((r) => r.itemCode === 'TMT-12')!;
    expect(steel).toMatchObject({ material: 'Steel 12 mm', received: 300, issued: 120.5, balance: 179.5, warehouse: 'Site A' });
    expect(g[1].rows[0]).toMatchObject({ received: 0, issued: 20, balance: -20 });
  });

  it('filters by project, warehouse, search and building materials', () => {
    expect(projectStock(moves, items, projects, { project: 'P2' }).map((x) => x.project)).toEqual(['P2']);
    expect(projectStock(moves, items, projects, { buildingOnly: true })[0].rows.map((r) => r.itemCode)).toEqual(['OPC', 'TMT-12']);
    expect(projectStock(moves, items, projects, { search: 'diesel' })[0].rows.map((r) => r.itemCode)).toEqual(['DSL']);
    expect(projectStock(moves, items, projects, { warehouse: 'Store' }).map((x) => x.project)).toEqual(['P2']);
  });
});

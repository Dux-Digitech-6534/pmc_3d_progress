import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/data/xlsxReader';
import { workbookToModel } from '../src/domain/excelModel';
import { parseAndValidateModel } from '../src/domain/modelValidation';

const template = () => {
  const b = readFileSync('tests/fixtures/PMC-3D-BOQ-Template.xlsx');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('Excel 3D + BOQ upload', () => {
  it('reads the sheets of the template', async () => {
    const book = await readXlsx(template());
    expect(Object.keys(book)).toEqual(['Guide', 'Project', 'Levels', 'Elements', 'BBS', 'Openings']);
    expect(book.Elements[0][0]).toBe('Element Code');
    expect(book.Elements[1].slice(0, 6)).toEqual(['F-X1Y1', 'footing', 'FDN', -3, -2, -1.05]);
  });

  it('turns the template into a valid model with BOQ, BBS, grades and openings', async () => {
    const res = workbookToModel(await readXlsx(template()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = parseAndValidateModel(res.text);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    const doc = JSON.parse(res.text);
    expect(doc.project).toMatchObject({ id: 'PMC-TEST-PH1', name: 'Test Pump House' });
    expect(doc.elements).toHaveLength(38);
    const col = doc.elements.find((e: { code: string }) => e.code === 'C-X1Y1');
    expect(col.geometry).toEqual({ shape: 'box', position: [-3, 1.3, -2], size: [0.3, 3.8, 0.3] });
    expect(col.concreteGrade).toBe('M25');
    expect(Object.values(col.steelByDia as Record<string, number>).reduce((a, b) => a + b, 0)).toBeCloseTo(col.plannedQuantities.REINF.quantity, 1);
    const wall = doc.elements.find((e: { code: string }) => e.code === 'W-X1Y1-X2Y1');
    expect(wall.geometry.openings).toEqual([{ center: 0, bottom: 0, width: 1, height: 2.1 }]);
    expect(wall.plannedQuantities.CONC).toBeUndefined();
    expect(doc.activities.find((a: { code: string }) => a.code === 'BRICK').appliesTo).toEqual(['wall']);
  });

  it('names the sheet, row and column of mistakes', () => {
    const res = workbookToModel({
      Project: [['Field', 'Value'], ['Project ID', 'P1']],
      Levels: [['Level ID', 'Level Name', 'Building', 'Elevation (m)'], ['GF', 'Ground', 'B', 0]],
      Elements: [
        ['Element Code', 'Type', 'Level ID', 'X (m)', 'Y (m)', 'Bottom (m)', 'Length (m)', 'Width (m)', 'Height (m)', 'Concrete (m3)'],
        ['C1', 'column', 'GF', 0, 0, 0, 0.3, 0.3, 'abc', 0.27],
      ],
      BBS: [['Element Code', 'Bar Dia (mm)', 'Steel (kg)'], ['C9', 12, 10]],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContain('Elements row 2: C1 — "Height (m)" is "abc", not a number.');
    expect(res.errors).toContain('BBS: element "C9" is not in the Elements sheet.');
  });

  it('reports a missing sheet or column', () => {
    const res = workbookToModel({ Project: [['Field', 'Value']], Levels: [['Level ID', 'Level Name']] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual(['Sheet "Levels": columns "Building", "Elevation (m)" missing.', 'Sheet "Elements" is missing.']);
  });

  it('rejects a file that is not a workbook', async () => {
    await expect(readXlsx(new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer)).rejects.toThrow('not an Excel');
  });
});

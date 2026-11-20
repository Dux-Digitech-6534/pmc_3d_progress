import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/data/xlsxReader';
import { buildXlsx } from '../src/lib/xlsxWriter';

describe('xlsx writer', () => {
  it('writes a sheet the reader (and Excel) can open: values, numbers, text with & < >', async () => {
    const bytes = buildXlsx({
      name: 'Material Requirement',
      cols: [6, 30, 14],
      rows: [
        [{ v: 'MATERIAL REQUIREMENT', s: 'title' }],
        [],
        ['Sr', 'Material', 'Quantity'].map((v) => ({ v, s: 'head' as const })),
        [{ v: 1, s: 'int' }, { v: 'Steel <TMT> & bars', s: 'cell' }, { v: 143.85, s: 'num' }],
        [null, 'Bricks', 1594],
      ],
      merges: ['A1:C1'],
    });
    const wb = await readXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const rows = wb['Material Requirement'];
    expect(rows[0][0]).toBe('MATERIAL REQUIREMENT');
    expect(rows[2]).toEqual(['Sr', 'Material', 'Quantity']);
    expect(rows[3]).toEqual([1, 'Steel <TMT> & bars', 143.85]);
    expect(rows[4]).toEqual([null, 'Bricks', 1594]);
  });
});

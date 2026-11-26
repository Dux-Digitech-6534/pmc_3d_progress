import { describe, expect, it } from 'vitest';
import { plainText } from '../src/data/frappeApi';

describe('plainText (Frappe error messages)', () => {
  it('drops tags from the permission error', () => {
    expect(
      plainText('User <strong>a@b.org</strong> does not have doctype access via role permission for document <strong>Stock Entry</strong>'),
    ).toBe('User a@b.org does not have doctype access via role permission for document Stock Entry');
  });

  it('turns <br> into new lines and decodes entities', () => {
    expect(plainText('Row 1: &quot;TMT&quot; &amp; RMC<br>Row 2')).toBe('Row 1: "TMT" & RMC\nRow 2');
  });

  it('leaves plain text alone', () => {
    expect(plainText('Qty must be more than 0')).toBe('Qty must be more than 0');
  });
});

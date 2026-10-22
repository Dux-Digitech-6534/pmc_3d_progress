import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DrawingReadingSchema } from '../src/ai/drawingSchema';

// The Frappe server asks Claude for exactly this JSON schema (pmc_3d_progress/ai_schema.json), so the
// server's answer always fits what the page's readingToSpec expects. Regenerate after changing the
// zod schema with:  WRITE_AI_SCHEMA=1 npx vitest run tests/aiSchema.test.ts
const SCHEMA_FILE = '../pmc_3d_progress/ai_schema.json';

describe('AI reading schema shared with the Frappe server', () => {
  it('pmc_3d_progress/ai_schema.json matches the zod schema', () => {
    const expected = JSON.stringify(betaZodOutputFormat(DrawingReadingSchema).schema, null, 1) + '\n';
    if (process.env.WRITE_AI_SCHEMA) writeFileSync(SCHEMA_FILE, expected);
    expect(existsSync(SCHEMA_FILE)).toBe(true);
    expect(readFileSync(SCHEMA_FILE, 'utf8')).toBe(expected);
  });
});

import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DrawingReadingSchema } from '../src/ai/drawingSchema';
import { geminiResponseSchema } from '../src/ai/geminiReader';

// The Frappe server asks the AI for exactly these JSON schemas (pmc_3d_progress/ai_schema.json for
// Claude, gemini_schema.json for Gemini), so the server's answer always fits what the page's
// readingToSpec expects. Regenerate after changing the zod schema with:
//   WRITE_AI_SCHEMA=1 npx vitest run tests/aiSchema.test.ts
const FILES = {
  '../pmc_3d_progress/ai_schema.json': () => betaZodOutputFormat(DrawingReadingSchema).schema,
  '../pmc_3d_progress/gemini_schema.json': geminiResponseSchema,
};

describe('AI reading schemas shared with the Frappe server', () => {
  for (const [file, schema] of Object.entries(FILES)) {
    it(`${file.slice(3)} matches the zod schema`, () => {
      const expected = JSON.stringify(schema(), null, 1) + '\n';
      if (process.env.WRITE_AI_SCHEMA) writeFileSync(file, expected);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(expected);
    });
  }
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingReading } from '../src/ai/drawingSchema';
import { GeminiError, readDrawingsWithGemini } from '../src/ai/geminiReader';

/** What a good reading of the "Typical Drawing of Security Cabin" looks like. */
const cabin = (): DrawingReading => ({
  structureKind: 'building',
  elements: [],
  projectName: 'Security Cabin',
  buildingName: 'Security Cabin',
  xSpansMm: [3230],
  ySpansMm: [3230],
  columnTypes: [{ code: 'C1', widthMm: 230, depthMm: 230, footingCode: 'F1' }],
  footingTypes: [{ code: 'F1', lengthMm: 1200, widthMm: 1200, depthMm: 300 }],
  columns: [
    { grid: 'X1Y1', columnCode: 'C1' },
    { grid: 'X2Y1', columnCode: 'C1' },
    { grid: 'X1Y2', columnCode: 'C1' },
    { grid: 'X2Y2', columnCode: 'C1' },
  ],
  foundationDepthMm: 1200,
  roofLevelMm: 3000,
  plinthBeam: { present: true, widthMm: 230, depthMm: 300 },
  roofBeam: { present: true, widthMm: 230, depthMm: 300 },
  slab: { present: true, thicknessMm: 125, overhangMm: 450 },
  walls: { present: true, thicknessMm: 230, alsoOnInternalGridLines: false },
  openingTypes: [
    { mark: 'D', kind: 'door', widthMm: 900, heightMm: 2100, sillMm: 0 },
    { mark: 'W', kind: 'window', widthMm: 1500, heightMm: 1200, sillMm: 900 },
    { mark: 'V', kind: 'ventilator', widthMm: 600, heightMm: 450, sillMm: 1800 },
  ],
  openings: [
    { mark: 'D', fromGrid: 'X1Y1', toGrid: 'X2Y1', centreFromStartMm: 800 },
    { mark: 'W', fromGrid: 'X2Y1', toGrid: 'X2Y2', centreFromStartMm: null },
    { mark: 'V', fromGrid: 'X2Y2', toGrid: 'X1Y2', centreFromStartMm: 700 }, // given right-to-left
  ],
  lintel: { present: true, depthMm: 150 },
  chhajja: { present: true, projectionMm: 450, thicknessMm: 75 },
  assumptions: ['Footing size not on drawing; typical 1200 × 1200 × 300 assumed.'],
  confidence: 'medium',
});

const pdf = { name: 'cabin.pdf', kind: 'pdf' as const, blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }) };

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('Gemini drawing reader', () => {
  it('sends the drawing with an inlined JSON schema and returns the parsed reading', async () => {
    const fetch = mockFetch(200, {
      candidates: [{ content: { parts: [{ text: JSON.stringify(cabin()) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 50 },
      modelVersion: 'gemini-test',
    });
    const res = await readDrawingsWithGemini([pdf], ' AIza-test ');
    expect(res.reading.xSpansMm).toEqual([3230]);
    expect(res).toMatchObject({ model: 'gemini-test', inputTokens: 1200, outputTokens: 350 });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test');
    const sent = JSON.parse(init.body as string);
    const schemaText = JSON.stringify(sent.generationConfig.responseJsonSchema);
    expect(schemaText).not.toContain('$ref');
    expect(schemaText).not.toContain('$schema');
    expect(sent.contents[0].parts.some((p: { inline_data?: { mime_type: string } }) => p.inline_data?.mime_type === 'application/pdf')).toBe(true);
  });

  it('tries 3 times when Gemini is busy, then explains a used-up free limit in plain words', async () => {
    vi.useFakeTimers();
    try {
      const fetch = mockFetch(429, { error: { message: 'Resource exhausted' } });
      const done = expect(readDrawingsWithGemini([pdf], 'k')).rejects.toThrow(/free Gemini limit/);
      await vi.advanceTimersByTimeAsync(25_000);
      await done;
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('succeeds when Gemini answers on a retry, and passes the engineer\'s note along', async () => {
    vi.useFakeTimers();
    try {
      const ok = { candidates: [{ content: { parts: [{ text: JSON.stringify(cabin()) }] }, finishReason: 'STOP' }] };
      const fn = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 200 }));
      vi.stubGlobal('fetch', fn);
      const run = readDrawingsWithGemini([pdf], 'k', undefined, 'boundary wall only');
      await vi.advanceTimersByTimeAsync(6_000);
      const res = await run;
      expect(res.reading.xSpansMm).toEqual([3230]);
      expect(fn).toHaveBeenCalledTimes(2);
      const sent = JSON.parse((fn.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
      expect(sent.contents[0].parts.at(-1).text).toContain('The engineer wants this modelled: boundary wall only');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an answer that is not model data', async () => {
    mockFetch(200, { candidates: [{ content: { parts: [{ text: '{"projectName":"x"}' }] }, finishReason: 'STOP' }] });
    await expect(readDrawingsWithGemini([pdf], 'k')).rejects.toBeInstanceOf(GeminiError);
  });
});

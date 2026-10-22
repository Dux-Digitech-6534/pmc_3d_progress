// Frappe mode: the drawing is read by the server (pmc_3d_progress/ai.py) with the key from
// PMC Settings. The reading runs as a background job; the page polls until it is done.

import { call } from '../data/frappeApi';
import type { DrawingReadResult } from './drawingReader';
import { DrawingReadingSchema } from './drawingSchema';

const POLL_MS = 3000;
const GIVE_UP_MS = 16 * 60 * 1000;

interface ReadingState {
  status: 'queued' | 'running' | 'done' | 'error';
  reading?: unknown;
  error?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('Cancelled.'));
    });
  });

export async function readDrawingsOnServer(drawingIds: string[], signal?: AbortSignal): Promise<DrawingReadResult> {
  if (!drawingIds.length) throw new Error('Upload at least one drawing first.');
  const { readingId } = await call<{ readingId: string }>('ai.start_reading', { drawing_ids: drawingIds });
  const started = Date.now();
  while (Date.now() - started < GIVE_UP_MS) {
    await wait(POLL_MS, signal);
    const state = await call<ReadingState>('ai.get_reading', { reading_id: readingId }, 'GET');
    if (state.status === 'error') throw new Error(state.error ?? 'The drawing was not read.');
    if (state.status === 'done') {
      const parsed = DrawingReadingSchema.safeParse(state.reading);
      if (!parsed.success) throw new Error('The AI answer could not be read as model data. Try again.');
      return { reading: parsed.data, model: state.model ?? '', inputTokens: state.inputTokens ?? 0, outputTokens: state.outputTokens ?? 0 };
    }
  }
  throw new Error('The AI reading is taking too long. Check that the server background workers are running, then try again.');
}

// Reads a construction drawing with Google Gemini instead of Claude — same prompt, same JSON shape
// (DrawingReadingSchema), so the Model Builder fills the form the same way. Used for testing on the
// Gemini API free tier. In the Frappe build the server makes this call (pmc_3d_progress/ai.py) with
// gemini_schema.json, which tests/aiSchema.test.ts keeps equal to geminiResponseSchema().
//
// Security: the key is stored only in this browser's localStorage and sent only to
// generativelanguage.googleapis.com. On the free tier Google may use what is sent (the drawings) to
// improve its products — do not send confidential client drawings with a free-tier key.

import * as z from 'zod/v4';
import { DrawingReadingSchema } from './drawingSchema';
import { blobToBase64, prepareImage, SYSTEM, USER_TEXT, type DrawingInput, type DrawingReadResult } from './drawingReader';

export const GEMINI_MODEL = 'gemini-3.8-flash';

const KEY_STORAGE = 'pmc3d.geminiApiKey';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_REQUEST_BYTES = 19 * 1024 * 1024; // inline data limit is 20 MB per request

export function getGeminiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}
export function saveGeminiKey(key: string) {
  localStorage.setItem(KEY_STORAGE, key.trim());
}
export function forgetGeminiKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* nothing stored */
  }
}

// Plain JSON Schema with every sub-schema inlined (no $ref), which Gemini's structured output accepts.
export function geminiResponseSchema() {
  const { $schema: _drop, ...schema } = z.toJSONSchema(DrawingReadingSchema) as Record<string, unknown>;
  return schema;
}

/** Error raised for a failed Gemini call, already in plain words for the engineer. */
export class GeminiError extends Error {}

function httpMessage(status: number, apiMessage: string): string {
  if (status === 400 && /api key/i.test(apiMessage)) return 'The Gemini API key was rejected. Check that it is a valid key from aistudio.google.com.';
  if (status === 401 || status === 403) return 'The Gemini API key was rejected or is not allowed to use this model. Create a new key at aistudio.google.com.';
  if (status === 404) return `The Gemini model ${GEMINI_MODEL} is not available for this key: ${apiMessage}`;
  if (status === 429) return 'The free Gemini limit is used up for now (too many requests or tokens). Wait a minute — or until tomorrow for the daily limit — and try again.';
  if (status >= 500) return 'The Gemini service had a temporary problem. Try again in a moment.';
  return `Gemini request failed (${status}): ${apiMessage}`;
}

export async function readDrawingsWithGemini(files: DrawingInput[], apiKey: string, signal?: AbortSignal): Promise<DrawingReadResult> {
  if (!files.length) throw new GeminiError('Upload at least one drawing first.');
  if (!apiKey.trim()) throw new GeminiError('Enter your Gemini API key first.');

  const parts: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const f of files) {
    if (f.kind === 'pdf') {
      const data = await blobToBase64(f.blob);
      bytes += data.length;
      parts.push({ text: `Drawing: ${f.name}` }, { inline_data: { mime_type: 'application/pdf', data } });
    } else {
      const img = await prepareImage(f.blob);
      bytes += img.data.length;
      parts.push({ text: `Drawing: ${f.name}` }, { inline_data: { mime_type: img.mediaType, data: img.data } });
    }
  }
  if (bytes > MAX_REQUEST_BYTES) {
    throw new GeminiError(
      `The drawings are too large to send together (${(bytes / 1024 / 1024).toFixed(1)} MB after encoding, Gemini limit about 20 MB). Remove some drawings or upload smaller files.`,
    );
  }
  parts.push({ text: USER_TEXT });

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: geminiResponseSchema(), maxOutputTokens: 32000 },
      }),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new GeminiError('Cancelled.');
    throw new GeminiError('Could not reach generativelanguage.googleapis.com. Check the internet connection (the AI reader needs internet).');
  }

  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    modelVersion?: string;
  };
  if (!res.ok) throw new GeminiError(httpMessage(res.status, body.error?.message ?? res.statusText));
  if (body.promptFeedback?.blockReason) throw new GeminiError(`Gemini declined to read this drawing (${body.promptFeedback.blockReason}).`);

  const cand = body.candidates?.[0];
  if (cand?.finishReason === 'MAX_TOKENS') throw new GeminiError('The drawing has more detail than one reading can return. Try uploading one sheet at a time.');
  if (cand?.finishReason && cand.finishReason !== 'STOP') throw new GeminiError(`Gemini stopped without an answer (${cand.finishReason}). Try again.`);
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join('');

  let parsed;
  try {
    parsed = DrawingReadingSchema.safeParse(JSON.parse(text));
  } catch {
    throw new GeminiError('The Gemini answer could not be read as model data. Try again.');
  }
  if (!parsed.success) throw new GeminiError('The Gemini answer did not have all the model data. Try again.');

  const u = body.usageMetadata ?? {};
  return {
    reading: parsed.data,
    model: body.modelVersion ?? GEMINI_MODEL,
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

// Reads a construction drawing (PDF / image) with Claude and returns a structured reading that the
// Model Builder turns into a 3D model. Runs in the browser with the user's own Anthropic API key.
//
// Security: the key is stored only in this browser's localStorage and sent only to
// api.anthropic.com. Anyone who can open this browser profile can use it — do not save a key on a
// shared computer. In ERPNext this call must move to the server so the key never reaches a browser.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { DrawingReadingSchema, type DrawingReading } from './drawingSchema';

export const AI_MODEL = 'claude-opus-5-5';

// Not under the "pmc3d.v1." prefix on purpose: "Clear all data" removes project data, not the key.
const KEY_STORAGE = 'pmc3d.anthropicApiKey';

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}
export function saveApiKey(key: string) {
  localStorage.setItem(KEY_STORAGE, key.trim());
}
export function forgetApiKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* nothing stored */
  }
}

export interface DrawingInput {
  name: string;
  kind: 'pdf' | 'image';
  blob: Blob;
}

export interface DrawingReadResult {
  reading: DrawingReading;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const MAX_REQUEST_BYTES = 30 * 1024 * 1024; // API request limit is 32 MB; keep headroom for JSON
const MAX_IMAGE_EDGE = 2400; // px — enough to read dimension text; bigger images are scaled down
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // per image, before base64 (the API allows 5 MB encoded)

export const SYSTEM = `You read construction drawings (plans, sections, elevations, schedules) and extract the data needed to build a simple 3D structural model of the building, including its walls, doors and windows.

Coordinate and naming conventions you must follow, whatever labels the drawing uses:
- Grid lines: X1, X2, … are the vertical column lines on the plan from LEFT to RIGHT. Y1, Y2, … are the horizontal column lines from the BOTTOM edge of the plan (the front / entrance side) to the TOP. If the drawing has its own grid labels (A, B, C / 1, 2, 3), map them to this convention and say so in assumptions.
- Spacings are centre-to-centre of columns, in millimetres. If the drawing only gives clear inside dimensions (e.g. "3000 x 3000" with 230 mm walls), add the wall / column thickness to get centre-to-centre, and record that in assumptions.
- A grid point is written like "X1Y1". List every column position.
- Levels are measured from ground / plinth level (0). foundationDepthMm is how far the footing bottom is below it; roofLevelMm is the top of the roof beams (bottom of the roof slab) above it.
- Walls run along grid lines between columns. Each door / window / ventilator sits in one wall: give the two grid points at the ends of that wall and the distance from the first one to the opening centre (null when centred).
- Use the drawing's own marks for openings (D, D1, W, V …) and the sizes from its door / window schedule. Doors have sill 0.

Only use values you can read or reasonably derive from the drawing. When something is not shown (for example footing depth, beam depth or roof level), use a typical value for a small single-storey RCC building and list it in assumptions, so an engineer can check it. Set confidence to "low" if the drawing is unclear or not a building drawing.`;

export const USER_TEXT = `Read the attached drawing(s) and return the structured data for the 3D model. Look at every view — plan, section, elevation, schedules and notes — before answering.`;

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Scale large photos / scans down so they fit the per-image limit while keeping text legible. */
export async function prepareImage(blob: Blob): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }> {
  const type = blob.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  const bitmap = await createImageBitmap(blob);
  const edge = Math.max(bitmap.width, bitmap.height);
  if (edge <= MAX_IMAGE_EDGE && blob.size <= MAX_IMAGE_BYTES && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) {
    bitmap.close();
    return { data: await blobToBase64(blob), mediaType: type };
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const out = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not convert the image.'))), 'image/jpeg', 0.9));
  return { data: await blobToBase64(out), mediaType: 'image/jpeg' };
}

/** Human-readable message for any failure of the AI call. */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof Anthropic.APIUserAbortError) return 'Cancelled.';
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check that it is a valid Anthropic API key (it starts with "sk-ant-").';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use this model. Check the key\'s workspace and permissions in the Anthropic Console.';
  if (e instanceof Anthropic.RateLimitError) return 'Too many requests or not enough API credit right now. Wait a minute and try again, or check billing in the Anthropic Console.';
  if (e instanceof Anthropic.BadRequestError) return `The request was not accepted: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'The AI took too long to answer. Try again, or upload a smaller / clearer drawing.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach api.anthropic.com. Check the internet connection (the AI reader needs internet).';
  if (e instanceof Anthropic.InternalServerError) return 'The AI service had a temporary problem. Try again in a moment.';
  if (e instanceof Anthropic.APIError) return `AI request failed (${e.status ?? 'error'}): ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export async function readDrawingsWithAI(files: DrawingInput[], apiKey: string, signal?: AbortSignal): Promise<DrawingReadResult> {
  if (!files.length) throw new Error('Upload at least one drawing first.');
  if (!apiKey.trim()) throw new Error('Enter your Anthropic API key first.');

  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  let bytes = 0;
  for (const f of files) {
    if (f.kind === 'pdf') {
      const data = await blobToBase64(f.blob);
      bytes += data.length;
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: f.name });
    } else {
      const img = await prepareImage(f.blob);
      bytes += img.data.length;
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
  }
  if (bytes > MAX_REQUEST_BYTES) {
    throw new Error(`The drawings are too large to send together (${(bytes / 1024 / 1024).toFixed(1)} MB after encoding, limit about 30 MB). Remove some drawings or upload smaller files.`);
  }
  content.push({ type: 'text', text: USER_TEXT });

  const client = new Anthropic({ apiKey: apiKey.trim(), dangerouslyAllowBrowser: true, maxRetries: 2 });
  const response = await client.beta.messages.parse(
    {
      model: AI_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'high', format: betaZodOutputFormat(DrawingReadingSchema) },
      // On a safety decline the API retries the request on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    },
    { signal, timeout: 10 * 60 * 1000 },
  );

  if (response.stop_reason === 'refusal') {
    throw new Error(`The AI declined to read this drawing${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('The drawing has more detail than one reading can return. Try uploading one sheet at a time.');
  if (!response.parsed_output) throw new Error('The AI answer could not be read as model data. Try again.');

  return {
    reading: response.parsed_output,
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

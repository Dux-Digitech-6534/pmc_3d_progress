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

export const SYSTEM = `You read construction drawings (plans, sections, elevations, schedules, structural details) and extract the data needed to build a simple 3D structural model with planned quantities.

First decide structureKind — what the drawing is for:
- "building": rooms such as a cabin, office, house or block with a roof slab. List EVERY room / space in "rooms" and EVERY door and window in "roomOpenings" — the walls, columns, beams and slab are worked out from the rooms, so the rooms must reproduce the plan exactly: each room is a rectangle (split an L-shaped space into rectangles), rooms that share a wall use the same line, and together they cover the whole floor plan (passages, toilets, stairs and verandas too). Name the staircase room "Stair" on every floor it is drawn on (a dog-legged stair is built in it up to the next floor or the roof). Also fill the column / footing schedules, levels, wall thickness, door / window sizes and lintel / chhajja as for any building; the grid fields may be minimal.
- "boundary-wall": a compound / boundary wall — piers (pillars) at regular spacing on a line or around a plot, with footings, a plinth beam, wall panels and a top / coping beam, and no roof. xSpansMm are the pier spacings along the wall; ySpansMm is [] for a straight wall, or the pier spacings along the other side when the wall goes around a plot. columns may be empty (every pier position is then filled with the first column type). roofLevelMm is the top of the wall (top of the coping beam) above ground and roofBeam is the coping / top beam; slab.present is false. When only a typical panel is drawn and the total length is not shown, repeat the typical spacing 10 times and say so in assumptions. Gates go in openings.
- "other": anything else (water tank, culvert, staircase, retaining wall …). Then list every element in "elements" as a box; the grid fields may be minimal.
If the drawing shows several structures (e.g. a boundary wall and a security cabin), model the one the engineer asked for; if they did not say, the main one in the title, and name the others in assumptions.

Coordinate and naming conventions you must follow, whatever labels the drawing uses:
- Grid lines: X1, X2, … are the vertical column lines on the plan from LEFT to RIGHT. Y1, Y2, … are the horizontal column lines from the BOTTOM edge of the plan (the front / entrance side) to the TOP. If the drawing has its own grid labels (A, B, C / 1, 2, 3), map them to this convention and say so in assumptions.
- Spacings are centre-to-centre of columns, in millimetres. If the drawing only gives clear inside dimensions (e.g. "3000 x 3000" with 230 mm walls), add the wall / column thickness to get centre-to-centre, and record that in assumptions.
- A grid point is written like "X1Y1". List every column position (a boundary wall may leave the list empty).
- Levels are measured from ground / plinth level (0). foundationDepthMm is how far the footing bottom is below it; roofLevelMm is the top of the roof beams (bottom of the roof slab) above it.
- Walls run along grid lines between columns. Each door / window / ventilator sits in one wall: give the two grid points at the ends of that wall and the distance from the first one to the opening centre (null when centred).
- Use the drawing's own marks for openings (D, D1, W, V …) and the sizes from its door / window schedule. Doors have sill 0.
- rooms (for "building"): x / y = the room's front-left corner, measured from the front-left (bottom-left) corner of the building, width along X (left to right), depth along Y (front to back), all in mm, measured on the wall centre lines. Read the overall dimensions and each room's size ("12 x 18 ft" = width 12 ft along X, depth 18 ft along Y unless the layout clearly shows it the other way) and check that the rooms add up to the overall size. 1 ft = 304.8 mm, 1 in = 25.4 mm.
- roomOpenings (for "building"): every door and window with its centre on the wall line it sits in (same origin as the rooms), its width, height and sill (doors 0). Doors drawn as an arc: the opening is the straight side of the arc. The main entry is usually marked with an arrow.
- Storeys: count them from the sections and elevations (G+1 = ground + one floor). "rooms" and "roomOpenings" above are the GROUND floor only. upperFloors (for "building"): one entry per floor above the ground floor, bottom to top, read from that floor's own plan (FIRST FLOOR PLAN, SECOND FLOOR PLAN …): its rooms and roomOpenings with the SAME origin as the ground floor (line the plans up on a common outer corner), and floorToFloorMm = from the roof level of the floor below to this floor's roof level (from the section, e.g. 3.05 m = 3050). An open terrace or balcony is not a room. Empty for a single-storey building.
- parapet: present when the section or elevation shows a parapet wall on a roof or terrace, with its height (often 900–1000 mm) and thickness (often 115 mm).
- elements (only for "other"; empty otherwise): one box per footing, column, beam, slab, wall, lintel, chhajja, door or window, all in mm — xMm / yMm = centre on the plan from the left / front edge, bottomMm = level of its underside (0 = ground, negative below ground), lengthMm along X, widthMm along Y, heightMm. Use the drawing's marks as codes (F1, C1, B1 …), each code once (C1-1, C1-2 … for repeats).

Only use values you can read or reasonably derive from the drawing. When something is not shown (for example footing size, beam depth or roof level), use a typical value for a small RCC structure and list it in assumptions, so an engineer can check it. Set confidence to "low" if the drawing is unclear or not a construction drawing.`;

export const USER_TEXT = `Read the attached drawing(s) and return the structured data for the 3D model. Look at every view — plan, section, elevation, schedules and notes — before answering.`;

/** The request text, with what the engineer wants modelled when they said it (e.g. "boundary wall"). */
export const userText = (hint?: string) => (hint?.trim() ? `${USER_TEXT}\nThe engineer wants this modelled: ${hint.trim().slice(0, 300)}` : USER_TEXT);

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

export async function readDrawingsWithAI(files: DrawingInput[], apiKey: string, signal?: AbortSignal, hint?: string): Promise<DrawingReadResult> {
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
  content.push({ type: 'text', text: userText(hint) });

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

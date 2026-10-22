import { clear, createStore, del, get, set } from 'idb-keyval';
import { IS_FRAPPE } from '../config';
import { call, fetchFile, uploadFile } from './frappeApi';

/**
 * Project drawings (PDF or image) uploaded to build a model from.
 *  - Local mode: the file is a Blob in this browser's IndexedDB ("pmc3d-drawings"); the list per
 *    project is in localStorage under the app prefix, so "Clear all data" removes both.
 *  - Frappe mode: the file is a private Frappe File and the list is the "PMC Drawing" doctype.
 */
export const DRAWING_DB = 'pmc3d-drawings';
export const MAX_DRAWING_BYTES = 20 * 1024 * 1024;
const INDEX_KEY = 'pmc3d.v1.drawings';
export const DRAWING_ACCEPT = '.pdf,application/pdf,.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
const TYPES: Record<string, 'pdf' | 'image'> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
};

export interface DrawingMeta {
  id: string;
  projectId: string;
  name: string;
  kind: 'pdf' | 'image';
  type: string;
  size: number;
  uploadedAt: string;
  /** Frappe mode: the private file URL. */
  url?: string;
}

let store: ReturnType<typeof createStore> | null = null;
const getStore = () => {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available in this browser.');
  store ??= createStore(DRAWING_DB, 'drawings');
  return store;
};

const readIndex = (): DrawingMeta[] => {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as DrawingMeta[];
  } catch {
    return [];
  }
};
const writeIndex = (list: DrawingMeta[]) => localStorage.setItem(INDEX_KEY, JSON.stringify(list));

/** Type from the MIME type, or from the extension when the browser leaves the type empty. */
export function drawingKind(file: File): 'pdf' | 'image' | null {
  if (TYPES[file.type]) return TYPES[file.type];
  if (/\.pdf$/i.test(file.name)) return 'pdf';
  if (/\.(jpe?g|png|webp)$/i.test(file.name)) return 'image';
  return null;
}

export function validateDrawing(file: File): string | null {
  if (!drawingKind(file)) return `${file.name}: only PDF, JPG, PNG or WebP drawings can be uploaded (DWG / DXF / IFC are not supported here).`;
  if (file.size > MAX_DRAWING_BYTES) return `${file.name}: ${(file.size / 1024 / 1024).toFixed(1)} MB is over the 20 MB limit.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

export async function listDrawings(projectId: string): Promise<DrawingMeta[]> {
  if (!projectId) return [];
  if (IS_FRAPPE) return call<DrawingMeta[]>('api.list_drawings', { project_id: projectId }, 'GET');
  return readIndex().filter((d) => d.projectId === projectId);
}

/** Persist a drawing; resolves only after it is stored (and, locally, read back with the same size). */
export async function saveDrawing(projectId: string, file: File): Promise<DrawingMeta> {
  const err = validateDrawing(file);
  if (err) throw new Error(err);
  const kind = drawingKind(file)!;
  const type = file.type || (kind === 'pdf' ? 'application/pdf' : 'image/*');
  if (IS_FRAPPE) {
    const up = await uploadFile(file);
    return call<DrawingMeta>('api.add_drawing', {
      project_id: projectId,
      file_url: up.file_url,
      file_name: file.name,
      kind,
      content_type: type,
      size: file.size,
    });
  }
  const id = `DRW-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const s = getStore();
  await set(id, file, s);
  const back = await get<Blob>(id, s);
  if (!back || back.size !== file.size) throw new Error(`${file.name} could not be verified in browser storage.`);
  const meta: DrawingMeta = { id, projectId, name: file.name, kind, type, size: file.size, uploadedAt: new Date().toISOString() };
  writeIndex([...readIndex(), meta]);
  return meta;
}

export async function loadDrawing(meta: Pick<DrawingMeta, 'id' | 'url'>): Promise<Blob | null> {
  if (IS_FRAPPE) return meta.url ? fetchFile(meta.url) : null;
  try {
    return (await get<Blob>(meta.id, getStore())) ?? null;
  } catch {
    return null;
  }
}

export async function deleteDrawing(id: string) {
  if (IS_FRAPPE) {
    await call('api.delete_drawing', { drawing_id: id });
    return;
  }
  await del(id, getStore());
  writeIndex(readIndex().filter((d) => d.id !== id));
}

/** Move drawings uploaded under a draft project id to the real one (when the user changes the project ID). */
export async function reassignDrawings(fromProjectId: string, toProjectId: string) {
  if (fromProjectId === toProjectId) return;
  if (IS_FRAPPE) {
    await call('api.reassign_drawings', { from_project_id: fromProjectId, to_project_id: toProjectId });
    return;
  }
  writeIndex(readIndex().map((d) => (d.projectId === fromProjectId ? { ...d, projectId: toProjectId } : d)));
}

export async function clearDrawings() {
  if (IS_FRAPPE) return;
  try {
    localStorage.removeItem(INDEX_KEY);
    await clear(getStore());
  } catch {
    // IndexedDB unavailable: nothing was stored.
  }
}

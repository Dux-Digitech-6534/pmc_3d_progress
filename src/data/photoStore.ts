import { clear, createStore, del, get, set } from 'idb-keyval';
import type { PhotoMeta } from '../domain/types';

/**
 * Small photo attachments are stored as Blobs in this browser's IndexedDB
 * (database "pmc3d-photos"). They are NOT uploaded anywhere. In ERPNext they would go
 * through the Frappe file upload endpoint and be attached to the PMC DPR record.
 */
export const PHOTO_DB = 'pmc3d-photos';
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_PHOTOS = 3;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let store: ReturnType<typeof createStore> | null = null;
const getStore = () => {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available in this browser.');
  store ??= createStore(PHOTO_DB, 'photos');
  return store;
};

export function validatePhoto(file: File): string | null {
  if (!ACCEPTED.includes(file.type)) return `${file.name}: only JPEG, PNG, WebP or GIF images are accepted.`;
  if (file.size > MAX_PHOTO_BYTES) return `${file.name}: ${(file.size / 1024 / 1024).toFixed(1)} MB is over the 2 MB prototype limit.`;
  return null;
}

/** Persist a photo; resolves only after IndexedDB confirms the write, then reads it back to verify. */
export async function savePhoto(file: File): Promise<PhotoMeta> {
  const id = `PH-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const s = getStore();
  await set(id, file, s);
  const back = await get<Blob>(id, s);
  if (!back || back.size !== file.size) throw new Error(`${file.name} could not be verified in browser storage.`);
  return { id, name: file.name, type: file.type, size: file.size };
}

export async function loadPhoto(id: string): Promise<Blob | null> {
  try {
    return (await get<Blob>(id, getStore())) ?? null;
  } catch {
    return null;
  }
}

export async function deletePhoto(id: string) {
  await del(id, getStore());
}

export async function clearPhotos() {
  try {
    await clear(getStore());
  } catch {
    // IndexedDB unavailable: nothing was stored, nothing to clear.
  }
}

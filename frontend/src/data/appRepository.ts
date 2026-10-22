import { IS_FRAPPE } from '../config';
import { clearDrawings } from './drawingStore';
import { FrappeRepository } from './frappeRepository';
import { LocalRepository, MemoryStorage, type StorageLike } from './localRepository';
import { clearPhotos } from './photoStore';
import type { PmcRepository } from './repository';
import { seedDemoData } from './seed';

function browserStorage(): { storage: StorageLike; persistent: boolean } {
  try {
    const probe = '__pmc3d_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return { storage: window.localStorage, persistent: true };
  } catch {
    return { storage: new MemoryStorage(), persistent: false };
  }
}

const { storage, persistent } = browserStorage();

/** false when localStorage is blocked — the UI then warns that nothing survives a reload (local mode only). */
export const storageIsPersistent = IS_FRAPPE || persistent;

/**
 * The single repository instance used by the UI: the Frappe server when the page is served by the
 * pmc_3d_progress app, otherwise this browser's storage. Nothing else in the UI depends on which.
 * The local app starts EMPTY: the user creates the first project by uploading a drawing in Model Builder.
 */
export const repository: PmcRepository = IS_FRAPPE
  ? new FrappeRepository()
  : new LocalRepository({
      storage,
      latencyMs: 150,
      onReset: async () => {
        await clearPhotos();
        await clearDrawings();
      },
    });

/** Optional (local mode only): load the two sample security cabins with example entries. */
export async function loadDemoData() {
  await seedDemoData(new LocalRepository({ storage }));
}

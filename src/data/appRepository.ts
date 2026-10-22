import { LocalRepository, MemoryStorage, type StorageLike } from './localRepository';
import { clearDrawings } from './drawingStore';
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

/** false when localStorage is blocked — the UI then warns that nothing survives a reload. */
export const storageIsPersistent = persistent;

/**
 * The single repository instance used by the UI. Swap this for a FrappeRepository later;
 * nothing else in the UI needs to change.
 * The app starts EMPTY: the user creates the first project by uploading a drawing in Model Builder.
 */
export const repository: PmcRepository = new LocalRepository({
  storage,
  latencyMs: 150,
  onReset: async () => {
    await clearPhotos();
    await clearDrawings();
  },
});

/** Optional: load the two sample security cabins with example entries (only when there are no projects yet). */
export async function loadDemoData() {
  await seedDemoData(new LocalRepository({ storage }));
}

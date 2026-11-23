import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_CONCRETE_SETTINGS, type ConcreteSettings } from '../domain/concrete';
import { useApp } from './AppContext';

// One shared copy of the project's concrete settings (RMC / site mix, grade per type) for every screen.
let current: { projectId: string; data: ConcreteSettings | null } = { projectId: '', data: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setConcrete(projectId: string, data: ConcreteSettings) {
  current = { projectId, data };
  emit();
}

/** The concrete settings of the project chosen at the top (the defaults until they are read). */
export function useConcrete() {
  const { repo, projectId } = useApp();
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setConcrete(projectId, await repo.getConcreteSettings(projectId));
    } catch {
      // not readable (e.g. an older server): the defaults, as before this setting existed
      setConcrete(projectId, DEFAULT_CONCRETE_SETTINGS);
    }
  }, [repo, projectId]);
  useEffect(() => {
    if (projectId && snap.projectId !== projectId) void reload();
  }, [projectId, snap.projectId, reload]);
  const mine = snap.projectId === projectId && snap.data;
  return { settings: mine ? snap.data! : DEFAULT_CONCRETE_SETTINGS, loaded: !!mine, reload };
}

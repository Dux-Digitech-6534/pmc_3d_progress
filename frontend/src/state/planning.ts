import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { errorMessages } from '../data/repository';
import type { PlanningData } from '../domain/planning';
import { useApp } from './AppContext';

// One shared copy of the project's planning (plans, No work, start dates) for every screen that shows it.
let current: { projectId: string; data: PlanningData | null; error: string | null } = { projectId: '', data: null, error: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setPlanning(projectId: string, data: PlanningData) {
  current = { projectId, data: { plans: data.plans, starts: data.starts }, error: null };
  emit();
}

/** The planning of the project chosen at the top; `reload` reads it again from the server. */
export function usePlanning() {
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
      setPlanning(projectId, await repo.getPlanning(projectId));
    } catch (e) {
      current = { projectId, data: { plans: [], starts: [] }, error: errorMessages(e).join(' ') };
      emit();
    }
  }, [repo, projectId]);
  useEffect(() => {
    if (projectId && snap.projectId !== projectId) void reload();
  }, [projectId, snap.projectId, reload]);
  const mine = snap.projectId === projectId;
  return { data: mine ? snap.data : null, error: mine ? snap.error : null, reload };
}

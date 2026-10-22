import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IS_FRAPPE } from '../config';
import { repository } from '../data/appRepository';
import { getSession, type SessionInfo } from '../data/frappeRepository';
import { errorMessages, type PmcRepository } from '../data/repository';
import type { ElementRecord, ModelRecord, ProgressEntry, Project, Role } from '../domain/types';

export type Page = 'dashboard' | 'projects' | 'workspace' | 'dpr' | 'models' | 'builder';

export interface ProjectData {
  project: Project;
  /** Active model revision, or null when none imported. */
  model: ModelRecord | null;
  elements: ElementRecord[];
  /** Every entry of the project, all revisions (history). */
  allEntries: ProgressEntry[];
  /** Entries of the active revision only — the only ones used for progress. */
  entries: ProgressEntry[];
}

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

interface AppState {
  repo: PmcRepository;
  role: Role;
  setRole: (r: Role) => void;
  page: Page;
  go: (p: Page) => void;
  projects: Project[];
  projectId: string | null;
  setProjectId: (id: string) => void;
  data: ProjectData | null;
  loading: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  selection: Set<string>;
  setSelection: (s: Set<string>) => void;
  toasts: Toast[];
  notify: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  /** Frappe mode: the logged-in user and the PMC roles they may act as. null in local mode / while loading. */
  session: SessionInfo | null;
  sessionError: string | null;
}

const Ctx = createContext<AppState | null>(null);

const UI_KEY = 'pmc3d.v1.ui';
interface UiPrefs {
  role?: Role;
  projectId?: string;
  page?: Page;
}
const readPrefs = (): UiPrefs => {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as UiPrefs;
  } catch {
    return {};
  }
};
const writePrefs = (p: UiPrefs) => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(p));
  } catch {
    // UI preferences are a convenience only.
  }
};

export function AppProvider({ children }: { children: ReactNode }) {
  const prefs = useMemo(readPrefs, []);
  const [role, setRole] = useState<Role>(prefs.role ?? 'site-engineer');
  const [page, setPage] = useState<Page>(prefs.page ?? 'workspace');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectIdState] = useState<string | null>(prefs.projectId ?? null);
  const [data, setData] = useState<ProjectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const loadToken = useRef(0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Frappe: who is logged in, and which roles the role dropdown may offer.
  useEffect(() => {
    if (!IS_FRAPPE) return;
    getSession()
      .then((s) => {
        setSession(s);
        setRole((r) => (s.roles.includes(r) ? r : (s.roles[0] ?? r)));
      })
      .catch((e) => setSessionError(errorMessages(e).join(' ')));
  }, []);

  useEffect(() => writePrefs({ role, projectId: projectId ?? undefined, page }), [role, projectId, page]);

  const notify = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const load = useCallback(
    async (wantedProjectId: string | null) => {
      const token = ++loadToken.current;
      setLoading(true);
      setLoadError(null);
      try {
        const list = await repository.listProjects();
        const pid = list.some((p) => p.id === wantedProjectId) ? wantedProjectId! : list[0]?.id ?? null;
        if (!pid) {
          if (token !== loadToken.current) return;
          setProjects(list);
          setData(null);
          return;
        }
        const [project, model, elements, allEntries] = await Promise.all([
          repository.getProject(pid),
          repository.getProjectModel(pid),
          repository.listElements(pid),
          repository.listProgressEntries(pid),
        ]);
        if (token !== loadToken.current) return; // a newer load superseded this one
        setProjects(list);
        setProjectIdState(pid);
        setData({
          project: project!,
          model,
          elements,
          allEntries,
          entries: model ? allEntries.filter((e) => e.modelKey === model.key) : [],
        });
      } catch (e) {
        if (token === loadToken.current) setLoadError(errorMessages(e).join(' '));
      } finally {
        if (token === loadToken.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(projectId);
    // Only on mount; project switches call load explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setProjectId = useCallback(
    (id: string) => {
      setSelection(new Set());
      setProjectIdState(id);
      setData((d) => (d && d.project.id === id ? d : null)); // never show the previous project's data meanwhile
      void load(id);
    },
    [load],
  );

  const refresh = useCallback(() => load(projectId), [load, projectId]);

  const value: AppState = {
    repo: repository,
    role,
    setRole,
    page,
    go: setPage,
    projects,
    projectId,
    setProjectId,
    data,
    loading,
    loadError,
    refresh,
    selection,
    setSelection,
    toasts,
    notify,
    dismissToast,
    session,
    sessionError,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside AppProvider');
  return v;
}

export const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

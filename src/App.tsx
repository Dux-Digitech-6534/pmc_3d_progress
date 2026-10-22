import { useState } from 'react';
import { ConfirmDialog } from './components/ui';
import { loadDemoData, storageIsPersistent } from './data/appRepository';
import { errorMessages } from './data/repository';
import { ROLE_LABELS, type Role } from './domain/types';
import { Dashboard } from './pages/Dashboard';
import { DprList } from './pages/DprList';
import { ModelBuilder } from './pages/ModelBuilder';
import { ModelRegister } from './pages/ModelRegister';
import { Projects } from './pages/Projects';
import { Workspace } from './pages/Workspace';
import { AppProvider, useApp, type Page } from './state/AppContext';

const NAV: { page: Page; label: string; icon: string }[] = [
  { page: 'dashboard', label: 'Dashboard', icon: '▦' },
  { page: 'projects', label: 'Projects', icon: '▤' },
  { page: 'workspace', label: '3D Workspace', icon: '◈' },
  { page: 'dpr', label: 'Daily Progress Reports', icon: '☰' },
  { page: 'builder', label: 'Model Builder', icon: '✎' },
  { page: 'models', label: 'Model Register', icon: '⬚' },
];

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const { page, go, projects, projectId, setProjectId, role, setRole, data, repo, notify, toasts, dismissToast, setSelection, loading, refresh } = useApp();
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  // No project yet: every page except the ones that create a model shows the welcome screen.
  const empty = !loading && projects.length === 0 && page !== 'builder' && page !== 'models';

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◆
          </span>
          <div>
            <div className="brand-name">PMC Progress</div>
            <div className="brand-sub">3D construction monitoring</div>
          </div>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.page}>
              <button className={page === n.page ? 'active' : ''} onClick={() => go(n.page)} aria-current={page === n.page ? 'page' : undefined}>
                <span className="nav-icon" aria-hidden>
                  {n.icon}
                </span>
                {n.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <button className="btn btn-small btn-ghost" onClick={() => setConfirmReset(true)}>
            Clear all data
          </button>
          <p>Prototype · data stays in this browser</p>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <label className="inline">
            <span className="muted small">Project</span>
            <select value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value)} aria-label="Current project" disabled={!projects.length}>
              {!projects.length && <option value="">— none —</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
          <div className="project-title">
            <span className="project-name">{data?.project.name ?? (projects.length ? '…' : 'No project yet')}</span>
            {data?.model && (
              <span className="muted small">
                {data.model.modelId} · {data.model.revision}
              </span>
            )}
          </div>
          <span className="spacer" />
          <label className="inline" title="Demo role switch — shows the workflow only. It is NOT authentication or security.">
            <span className="muted small">Demo role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Demo role">
              {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <span className="demo-pill" title="Local prototype. Data is stored only in this browser. The role switch is not authentication.">
            Local Demo
          </span>
        </header>
        {!storageIsPersistent && (
          <div className="alert alert-warn banner">Browser storage is blocked: changes will be lost when the page reloads.</div>
        )}
        <main className={`content ${page === 'workspace' ? 'content-full' : ''}`}>
          {empty && (
            <div className="page">
              <div className="welcome card">
                <h1>Welcome — start your first project</h1>
                <ol>
                  <li>
                    Open <b>Model Builder</b> and upload the project drawing (PDF or photo).
                  </li>
                  <li>
                    Click <b>Read drawing with AI</b> — the form (grid, columns, beams, slab, walls, doors, windows) is filled from the drawing.
                  </li>
                  <li>Check the values against the drawing, then <b>Create model</b>. The 3D model and progress tracking open from there.</li>
                </ol>
                <div className="card-actions">
                  <button className="btn btn-primary" onClick={() => go('builder')}>
                    Open Model Builder
                  </button>
                  <button
                    className="btn"
                    disabled={demoBusy}
                    onClick={async () => {
                      setDemoBusy(true);
                      try {
                        await loadDemoData();
                        await refresh();
                        notify('Demo data loaded (Security Cabin A and B). Use "Clear all data" to remove it.');
                      } catch (e) {
                        notify(errorMessages(e).join(' '), 'error');
                      } finally {
                        setDemoBusy(false);
                      }
                    }}
                  >
                    {demoBusy ? 'Loading…' : 'Load demo data instead'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {!empty && page === 'dashboard' && <Dashboard />}
          {!empty && page === 'projects' && <Projects />}
          {!empty && page === 'workspace' && <Workspace />}
          {!empty && page === 'dpr' && <DprList />}
          {page === 'builder' && <ModelBuilder />}
          {page === 'models' && <ModelRegister />}
        </main>
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span>{t.text}</span>
            <button className="btn-icon" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>

      {confirmReset && (
        <ConfirmDialog
          title="Clear all data?"
          danger
          busy={resetting}
          confirmLabel="Clear all data"
          message={
            <>
              <p>This deletes all projects, models, drawings, progress entries and photos created by this app in this browser. The app starts empty again. This cannot be undone.</p>
              <p className="muted small">Only this application's own storage (keys starting with "pmc3d.v1." and the "pmc3d-photos" / "pmc3d-drawings" databases) is cleared.</p>
            </>
          }
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            setResetting(true);
            try {
              await repo.resetDemoData();
              setSelection(new Set());
              setConfirmReset(false);
              await refresh();
              go('dashboard');
              notify('All data cleared.');
            } catch (e) {
              notify(errorMessages(e).join(' '), 'error');
            } finally {
              setResetting(false);
            }
          }}
        />
      )}
    </div>
  );
}

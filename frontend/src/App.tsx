import { useState } from 'react';
import { ConfirmDialog, EmptyState } from './components/ui';
import { IS_FRAPPE } from './config';
import { loadDemoData, storageIsPersistent } from './data/appRepository';
import { errorMessages } from './data/repository';
import { ROLE_LABELS, type Role } from './domain/types';
import { Dashboard } from './pages/Dashboard';
import { DprList } from './pages/DprList';
import { ModelBuilder } from './pages/ModelBuilder';
import { MaterialVariation } from './pages/MaterialVariation';
import { ModelRegister } from './pages/ModelRegister';
import { Projects } from './pages/Projects';
import { Workspace } from './pages/Workspace';
import { AppProvider, useApp, type Page } from './state/AppContext';

// icon = SVG path (24×24, stroked)
const NAV: { page: Page; label: string; icon: string }[] = [
  { page: 'dashboard', label: 'Dashboard', icon: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z' },
  { page: 'projects', label: 'Projects', icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { page: 'workspace', label: 'Work Done', icon: 'M12 2 3 7v10l9 5 9-5V7zM12 12l9-5M12 12 3 7M12 12v10' },
  { page: 'material', label: 'Material Required', icon: 'M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6' },
  { page: 'variation', label: 'Material Variation', icon: 'M4 19V5M4 19h16M8 15l3-4 3 2 5-6' },
  { page: 'dpr', label: 'Daily Progress Reports', icon: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6' },
  { page: 'models', label: '3D + BOQ Upload', icon: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3' },
  // drawing → model with AI: only for local work; on the server the 3D + BOQ is uploaded
  ...(IS_FRAPPE ? [] : [{ page: 'builder' as Page, label: 'Model Builder', icon: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4' }]),
];

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const { page, go, projects, projectId, setProjectId, role, setRole, data, repo, notify, toasts, dismissToast, setSelection, loading, refresh, session, sessionError } = useApp();
  // Frappe: only the roles this user has; locally the full demo role switch.
  const roleOptions = IS_FRAPPE ? (session?.roles ?? []) : (Object.keys(ROLE_LABELS) as Role[]);
  const noAccess = IS_FRAPPE && (!!sessionError || (session !== null && session.roles.length === 0));
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
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d={n.icon} />
                  </svg>
                </span>
                <span className="nav-label">{n.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          {!IS_FRAPPE && (
            <button className="btn btn-small btn-ghost" onClick={() => setConfirmReset(true)}>
              Clear all data
            </button>
          )}
          <p>{IS_FRAPPE ? 'Data saved on the server' : 'Prototype · data stays in this browser'}</p>
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
          <label
            className="inline"
            title={IS_FRAPPE ? 'Your PMC roles on this site. Every action is checked again on the server.' : 'Demo role switch — shows the workflow only. It is NOT authentication or security.'}
          >
            <span className="muted small">{IS_FRAPPE ? 'Role' : 'Demo role'}</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label={IS_FRAPPE ? 'Role' : 'Demo role'} disabled={roleOptions.length < 2}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          {IS_FRAPPE ? (
            <span className="demo-pill user-pill" title={session?.user}>
              {session?.fullName ?? '…'}
            </span>
          ) : (
            <span className="demo-pill" title="Local prototype. Data is stored only in this browser. The role switch is not authentication.">
              Local Demo
            </span>
          )}
        </header>
        {!storageIsPersistent && (
          <div className="alert alert-warn banner">Browser storage is blocked: changes will be lost when the page reloads.</div>
        )}
        <main className={`content ${page === 'workspace' || page === 'material' ? 'content-full' : ''}`}>
          {noAccess && (
            <EmptyState title="No access to PMC 3D Progress">
              {sessionError ??
                'Your user has no PMC role. Ask the administrator to give you PMC Site Engineer, PMC Reviewer or PMC Owner.'}
            </EmptyState>
          )}
          {!noAccess && empty && (
            <div className="page">
              <div className="welcome card">
                <h1>Welcome — start your first project</h1>
                <ol>
                  <li>
                    Open <b>3D + BOQ Upload</b> and upload the project's 3D + BOQ file.
                  </li>
                  <li>
                    In <b>Work Done</b>, select the elements and mark the work that is done; <b>Material Required</b> shows the material the selected elements need.
                  </li>
                  <li>The PMC Reviewer approves the work done; the 3D colours and progress update.</li>
                </ol>
                <div className="card-actions">
                  <button className="btn btn-primary" onClick={() => go('models')}>
                    Upload 3D + BOQ
                  </button>
                  {!IS_FRAPPE && (
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
                  )}
                </div>
              </div>
            </div>
          )}
          {!noAccess && !empty && page === 'dashboard' && <Dashboard />}
          {!noAccess && !empty && page === 'projects' && <Projects />}
          {!noAccess && !empty && page === 'workspace' && <Workspace key="work" mode="work" />}
          {!noAccess && !empty && page === 'material' && <Workspace key="material" mode="material" />}
          {!noAccess && !empty && page === 'variation' && <MaterialVariation />}
          {!noAccess && !empty && page === 'dpr' && <DprList />}
          {!noAccess && page === 'builder' && !IS_FRAPPE && <ModelBuilder />}
          {!noAccess && page === 'models' && <ModelRegister />}
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

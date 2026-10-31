import { IS_FRAPPE } from '../config';
import { useEffect, useState } from 'react';
import { EmptyState, fmtDateTime, PageHeader, Spinner } from '../components/ui';
import type { ModelRecord } from '../domain/types';
import { useApp } from '../state/AppContext';

export function Projects() {
  const { projects, repo, projectId, setProjectId, go, data } = useApp();
  const [models, setModels] = useState<ModelRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    void repo.listModels().then((m) => alive && setModels(m));
    return () => {
      alive = false;
    };
  }, [repo, data]);

  if (!projects.length) return <Spinner label="Loading projects…" />;

  return (
    <div className="page">
      <PageHeader title="Projects" subtitle="Each project has its own model revisions and progress records. Nothing is shared between projects." />
      <div className="project-grid">
        {projects.map((p) => {
          const active = models?.find((m) => m.key === p.activeModelKey);
          const revisions = models?.filter((m) => m.projectId === p.id && m.status !== 'Failed').length ?? 0;
          return (
            <article key={p.id} className={`card project-card ${p.id === projectId ? 'current' : ''}`}>
              <div className="project-card-head">
                <h2>{p.name}</h2>
                {p.id === projectId && <span className="badge badge-current">Current</span>}
              </div>
              <dl className="kv">
                <dt>Project ID</dt>
                <dd>
                  <code>{p.id}</code>
                </dd>
                <dt>Location</dt>
                <dd>{p.location ?? '—'}</dd>
                <dt>Client</dt>
                <dd>{p.client ?? '—'}</dd>
                <dt>Active model</dt>
                <dd>
                  {active ? (
                    <>
                      {active.name} <b>{active.revision}</b> · {active.elementCount} elements
                      <div className="muted small">Imported {fmtDateTime(active.importedAt)}</div>
                    </>
                  ) : models ? (
                    <span className="warn-text">No model imported yet</span>
                  ) : (
                    '…'
                  )}
                </dd>
                <dt>Revisions</dt>
                <dd>{revisions}</dd>
              </dl>
              <div className="card-actions">
                {active ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      if (p.id !== projectId) setProjectId(p.id);
                      go('workspace');
                    }}
                  >
                    Open 3D Workspace
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      if (p.id !== projectId) setProjectId(p.id);
                      go('models');
                    }}
                  >
                    Import model
                  </button>
                )}
                {p.id !== projectId && (
                  <button className="btn" onClick={() => setProjectId(p.id)}>
                    Make current
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {projects.length === 0 && <EmptyState title="No projects" />}
      <section className="card note">
        <h2 className="card-title">About this prototype</h2>
        <ul>
          <li>
            {IS_FRAPPE
              ? 'All projects, models, drawings and progress are saved on this Frappe server, with your login and PMC role. '
              : 'All projects, models, drawings and progress live only in this browser (localStorage and IndexedDB). No server or account is used. '}
            {!IS_FRAPPE && (
              <>
                Only <b>Read drawing with AI</b> (Model Builder) uses the internet, with your own API key.
              </>
            )}
          </li>
          <li>
            New project: <b>3D + BOQ Upload</b> → upload the 3D + BOQ file of the project (it names the project).
            {!IS_FRAPPE && (
              <>
                {' '}
                <b>Clear all data</b> (sidebar) removes every project.
              </>
            )}
          </li>
          <li>
            {IS_FRAPPE ? (
              <>
                The <b>role</b> in the top bar shows only the PMC roles your user has (Site Engineer records work, PMC Reviewer approves or returns it,
                Owner views approved progress). Every action is checked again on the server.
              </>
            ) : (
              <>
                The <b>role selector</b> in the top bar only demonstrates the Draft → Submitted → Approved/Returned workflow. It is not authentication or
                security — in ERPNext these rules must be enforced on the server.
              </>
            )}
          </li>
          <li>Generated models and quantities are for progress monitoring, not structural design. Check them against the approved drawings.</li>
        </ul>
      </section>
    </div>
  );
}

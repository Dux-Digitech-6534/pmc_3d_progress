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
            All projects, models, drawings and progress live only in this browser (localStorage and IndexedDB). No server or account is used. Only{' '}
            <b>Read drawing with AI</b> uses the internet, with your own Anthropic API key.
          </li>
          <li>
            New project: <b>Model Builder</b> → upload the drawing → Read drawing with AI → check → Create model. <b>Clear all data</b> (sidebar) removes
            every project.
          </li>
          <li>
            The <b>role selector</b> in the top bar only demonstrates the Draft → Submitted → Approved/Returned workflow. It is not authentication or
            security — in ERPNext these rules must be enforced on the server.
          </li>
          <li>Generated models and quantities are for progress monitoring, not structural design. Check them against the approved drawings.</li>
        </ul>
      </section>
    </div>
  );
}

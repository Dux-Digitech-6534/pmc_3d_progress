import { useEffect, useState } from 'react';
import { openModelInBuilder, startBlankBuilder } from './ModelBuilder';
import { ConfirmDialog, EmptyState, ErrorList, fmtDateTime, Modal, PageHeader, Spinner } from '../components/ui';
import { errorMessages, type ImportModelOutcome } from '../data/repository';
import { invalidSampleText, SAMPLE_MODELS, sampleText } from '../data/samples';
import { PLANNING_STATUSES, type ModelRecord, type ModelSourceType } from '../domain/types';
import { downloadText } from '../lib/download';
import { useApp } from '../state/AppContext';
import { IS_FRAPPE } from '../config';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** The sample offered for download next to the upload: it has the BBS bar sizes and grades. */
const FORMAT_SAMPLE = SAMPLE_MODELS.find((s) => s.id === 'b') ?? SAMPLE_MODELS[0];

/** Plain-language "how was this model made" shown under the model name. */
const HOW_MADE: Record<string, string> = {
  'Model Builder (from drawing)': 'Made from drawing',
  'Uploaded JSON file': 'Imported JSON file',
  'Bundled sample (procedural JSON)': 'Sample model',
};

export function ModelRegister() {
  const { repo, projects, projectId, setProjectId, data, refresh, notify, go, role } = useApp();
  const [review, setReview] = useState<{ model: ModelRecord; decision: 'approve' | 'return' } | null>(null);
  const [remarks, setRemarks] = useState('');
  const [reviewErrors, setReviewErrors] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);

  async function sendReview() {
    if (!review || reviewing) return;
    setReviewing(true);
    setReviewErrors([]);
    try {
      await repo.reviewModel(review.model.key, review.decision, remarks, role);
      notify(
        review.decision === 'approve'
          ? `${review.model.name} ${review.model.revision} approved — it is now the 3D model of ${projectName(review.model.projectId)}.`
          : `${review.model.name} ${review.model.revision} returned to the site engineer.`,
      );
      setReview(null);
      setRemarks('');
      if (review.decision === 'approve' && review.model.projectId !== projectId) setProjectId(review.model.projectId);
      else await refresh();
      setModels(await repo.listModels());
    } catch (e) {
      setReviewErrors(errorMessages(e));
    } finally {
      setReviewing(false);
    }
  }

  /** Approved work of earlier revisions of this model: what still counts, and what is on elements this revision no longer has. */
  function carryOver(m: ModelRecord) {
    if (!data || data.project.id !== m.projectId || !m.document) return null;
    const ids = new Set(m.document.elements.map((e) => e.id));
    const approved = data.allEntries.filter((e) => e.modelId === m.modelId && e.status === 'Approved');
    return { kept: approved.filter((e) => ids.has(e.elementId)).length, dropped: approved.filter((e) => !ids.has(e.elementId)) };
  }

  function correctInBuilder(m: ModelRecord) {
    if (!openModelInBuilder(m)) return notify('This model was not made in the Model Builder, so it cannot be opened there.', 'error');
    go('builder');
  }
  const [models, setModels] = useState<ModelRecord[] | null>(null);
  const [target, setTarget] = useState<string>('__file__');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(ImportModelOutcome & { sourceName: string }) | null>(null);
  const [activate, setActivate] = useState<ModelRecord | null>(null);
  const [errorsFor, setErrorsFor] = useState<ModelRecord | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // the server lets PMC Site Engineers and Reviewers upload models (not the Owner)
  const canUpload = role !== 'owner';

  useEffect(() => {
    let alive = true;
    void repo.listModels().then((m) => alive && setModels(m));
    return () => {
      alive = false;
    };
  }, [repo, data]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  async function runImport(text: string, sourceName: string, sourceType: ModelSourceType) {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const out = await repo.importModel({ text, sourceName, sourceType, targetProjectId: target === '__file__' ? undefined : target });
      setResult({ ...out, sourceName });
      if (out.ok && out.record) {
        notify(`Imported ${out.record.name} ${out.record.revision} — ${out.record.elementCount} elements.`);
        if (out.record.projectId !== projectId) setProjectId(out.record.projectId);
        else await refresh();
      } else {
        notify(`Import of ${sourceName} failed — see the errors below.`, 'error');
        await refresh();
      }
    } catch (e) {
      setResult({ ok: false, errors: errorMessages(e), warnings: [], sourceName });
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setResult({ ok: false, errors: [`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the prototype accepts model JSON files up to 5 MB.`], warnings: [], sourceName: file.name });
      return;
    }
    if (!/\.json$/i.test(file.name)) {
      setResult({
        ok: false,
        errors: [
          /\.(pdf|jpe?g|png|webp)$/i.test(file.name)
            ? `${file.name} is a drawing, not a 3D + BOQ file.${IS_FRAPPE ? ' Upload the JSON file of the model (see "File format").' : ' Build the model from it in Model Builder, or upload the JSON file of the model.'}`
            : `${file.name} is not a .json file. Upload the 3D + BOQ JSON file (see "File format").`,
        ],
        warnings: [],
        sourceName: file.name,
      });
      return;
    }
    await runImport(await file.text(), file.name, 'Uploaded JSON file');
  }

  return (
    <div className="page">
      {review && (
        <Modal
          title={`${review.decision === 'approve' ? 'Approve' : 'Return'} planning ${review.model.name} ${review.model.revision}`}
          onClose={() => !reviewing && setReview(null)}
          footer={
            <>
              <button className="btn" onClick={() => setReview(null)} disabled={reviewing}>
                Cancel
              </button>
              <button className={`btn ${review.decision === 'approve' ? 'btn-primary' : 'btn-danger'}`} onClick={() => void sendReview()} disabled={reviewing}>
                {reviewing ? 'Working…' : review.decision === 'approve' ? 'Approve — make it the 3D model' : 'Return to site engineer'}
              </button>
            </>
          }
        >
          <p className="small">
            {review.decision === 'approve'
              ? `The planning becomes the active 3D model of ${projectName(review.model.projectId)}; site progress is entered against it.`
              : 'The site engineer sees your remarks, corrects the planning in the Model Builder and submits it again.'}
          </p>
          {review.decision === 'approve' &&
            (() => {
              const c = carryOver(review.model);
              if (!c || (!c.kept && !c.dropped.length)) return null;
              return (
                <div className={`alert ${c.dropped.length ? 'alert-warn' : 'alert-info'} small`}>
                  {c.kept} approved entr{c.kept === 1 ? 'y' : 'ies'} of earlier revisions carr{c.kept === 1 ? 'ies' : 'y'} over to the same elements.
                  {c.dropped.length > 0 && (
                    <>
                      {' '}
                      <b>{c.dropped.length}</b> approved entr{c.dropped.length === 1 ? 'y is' : 'ies are'} on elements this revision no longer has (
                      {[...new Set(c.dropped.map((e) => e.elementCode))].slice(0, 6).join(', ')}
                      {new Set(c.dropped.map((e) => e.elementCode)).size > 6 ? ' …' : ''}) — kept in history, not counted.
                    </>
                  )}
                </div>
              );
            })()}
          <label className="stack">
            <span className="field-label">{review.decision === 'approve' ? 'Remarks (optional)' : 'What has to be corrected? (required)'}</span>
            <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={500} />
          </label>
          <ErrorList errors={reviewErrors} title="Not saved" />
        </Modal>
      )}
      <PageHeader
        title="3D + BOQ models"
        subtitle="The 3D model with its BOQ, per project. An uploaded change gets a new version (R02, R03 …); the Active one is shown in 3D and used for work done and material required."
        actions={
          !IS_FRAPPE && (
            <button className="btn" onClick={() => { startBlankBuilder(); go('builder'); }}>
              New model from drawing
            </button>
          )
        }
      />
      {canUpload && (
        <section className="card upload-card">
          <h2 className="card-title">Upload 3D + BOQ</h2>
          <p className="muted small">
            One JSON file with the elements (footings, columns, beams, slabs, walls …), their size and position, and the BOQ quantities of each — concrete,
            steel (with the BBS bar sizes), shuttering, brickwork, plaster. It becomes the Active model of the project straight away.
          </p>
          <div className="import-row">
            <label>
              Upload into
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="__file__">Project named in the file (created if new)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id}) — must match the file
                  </option>
                ))}
              </select>
            </label>
            <label className={`btn btn-primary ${busy ? 'disabled' : ''}`}>
              {busy ? 'Uploading…' : 'Choose file…'}
              <input
                type="file"
                accept=".json,application/json"
                hidden
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void onFile(f);
                }}
              />
            </label>
            <button className="link" onClick={() => downloadText(FORMAT_SAMPLE.fileName, sampleText(FORMAT_SAMPLE.json), 'application/json')}>
              Download a sample file
            </button>
          </div>
          {result && (
            <div className="import-result">
              {result.ok && result.record ? (
                <div className="alert alert-success">
                  <strong>
                    Uploaded {result.sourceName}: {result.record.name} {result.record.revision}, {result.record.elementCount} elements.
                  </strong>
                  {result.createdProject && <div>Project {result.record.projectId} was created from the file.</div>}
                  {result.supersededKey && <div>The previous version is now Superseded; approved work on elements that are still there carries over.</div>}
                  <div className="card-actions">
                    <button className="btn btn-small btn-primary" onClick={() => go('workspace')}>
                      Open in 3D
                    </button>
                  </div>
                </div>
              ) : (
                <ErrorList title={`Upload of ${result.sourceName} failed — nothing was changed`} errors={result.errors} />
              )}
              {result.warnings.length > 0 && (
                <div className="alert alert-warn">
                  <strong>Warnings ({result.warnings.length})</strong>
                  <ul>
                    {result.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <details className="format-ref">
            <summary>File format</summary>
            <p className="small">
              Format <code>pmc-procedural-model</code> version 1 (full reference: <code>docs/MODEL_FORMAT.md</code>). Lengths in metres, Y up.
            </p>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Rule</th>
                </tr>
              </thead>
              <tbody>
                <tr><td><code>format</code>, <code>formatVersion</code></td><td>"pmc-procedural-model", 1</td></tr>
                <tr><td><code>project.id</code>, <code>project.name</code></td><td>Required. Must match the project chosen above.</td></tr>
                <tr><td><code>model.id</code>, <code>model.revision</code></td><td>Required. A changed model uses a new revision (R02 …); a revision is never overwritten.</td></tr>
                <tr><td><code>buildings[]</code>, <code>levels[]</code></td><td>Unique ids; every level belongs to a building.</td></tr>
                <tr><td><code>activities[]</code></td><td>code, name, unit (kg, m2, m3, m, nos) and the element types they apply to — REINF, SHUT, CONC, BRICK, PLAST, FIX.</td></tr>
                <tr><td><code>elements[].id</code>, <code>code</code>, <code>type</code></td><td>Stable unique id; display code (C-01); footing, column, beam, slab, wall, lintel, chhajja, door or window.</td></tr>
                <tr><td><code>elements[].geometry</code></td><td>{'{ shape: "box", position: [x,y,z], size: [w,h,d] }'}; walls {'"wall"'} with openings, stairs {'"stair"'}.</td></tr>
                <tr><td><code>elements[].plannedQuantities</code></td><td>The BOQ of the element: {'{ "CONC": { quantity: 0.19, unit: "m3" }, "REINF": { … "kg" } … }'}.</td></tr>
                <tr><td><code>elements[].steelByDia</code></td><td>Optional. BBS: bar diameter mm → kg, e.g. {'{ "8": 6.9, "12": 13.7, "16": 13.7 }'}. Used for Material required.</td></tr>
                <tr><td><code>elements[].concreteGrade</code></td><td>Optional. e.g. "M25". Without it the grade of the model planning is used.</td></tr>
              </tbody>
            </table>
          </details>
        </section>
      )}
      <section className="card table-card">
        <h2 className="card-title">Models</h2>
        {!models ? (
          <Spinner />
        ) : models.length === 0 ? (
          <EmptyState
            title="No models yet"
          >
            Upload the 3D + BOQ file of the project above.
          </EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Project</th>
                <th title="R01 = first version; a changed model becomes R02, R03 …">Version</th>
                <th>Created</th>
                <th className="num" title="Footings, columns, beams, slab, walls, doors, windows …">Parts</th>
                <th title="Active = the version shown in 3D and used for progress">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...models].reverse().map((m) => (
                <tr key={m.key}>
                  <td>
                    {m.name}
                    <div className="muted small">{HOW_MADE[m.sourceType] ?? m.sourceType}</div>
                    {m.reviewRemarks && (
                      <div className={`small ${m.status === 'Returned' ? 'warn-text' : 'muted'}`}>
                        PMC: {m.reviewRemarks}
                        {m.reviewedBy ? ` — ${m.reviewedBy}` : ''}
                      </div>
                    )}
                  </td>
                  <td>{projectName(m.projectId)}</td>
                  <td>{m.revision}</td>
                  <td className="nowrap">{fmtDateTime(m.importedAt)}</td>
                  <td className="num">{m.elementCount || '—'}</td>
                  <td>
                    <span className={`badge badge-model-${m.status.toLowerCase().replace(/\s+/g, '-')}`}>{m.status}</span>
                  </td>
                  <td className="nowrap">
                    {m.status === 'Failed' && (
                      <button className="link" onClick={() => setErrorsFor(m)}>
                        Errors
                      </button>
                    )}
                    {m.status === 'Active' && m.projectId === projectId && (
                      <button className="link" onClick={() => go('workspace')}>
                        Open in 3D
                      </button>
                    )}
                    {m.status === 'Superseded' && (
                      <button className="link" onClick={() => setActivate(m)}>
                        Make active
                      </button>
                    )}
                    {PLANNING_STATUSES.includes(m.status) && (
                      <span className="row-actions">
                        {!IS_FRAPPE && (
                          <button className="link" onClick={() => correctInBuilder(m)}>
                            {role === 'pmc-reviewer' ? 'Check / correct' : 'Correct'} in Model Builder
                          </button>
                        )}
                        {role === 'pmc-reviewer' && m.status === 'Pending Approval' && (
                          <>
                            <button className="btn btn-small btn-primary" onClick={() => (setReview({ model: m, decision: 'approve' }), setRemarks(''), setReviewErrors([]))}>
                              Approve
                            </button>
                            <button className="btn btn-small" onClick={() => (setReview({ model: m, decision: 'return' }), setRemarks(''), setReviewErrors([]))}>
                              Return
                            </button>
                          </>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* sample models: for local work only */}
      {!IS_FRAPPE && (
        <details className="card advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
          <summary>
            <b>Advanced</b> <span className="muted small">— sample models. Not needed for normal work.</span>
          </summary>
          <div className="adv-block">
            <h3 className="section-title">Sample models</h3>
            <div className="sample-row">
              <span className="muted small">Bundled samples (same import pipeline as an uploaded file):</span>
              {SAMPLE_MODELS.map((s) => (
                <span key={s.id} className="sample">
                  <button className="btn btn-small" disabled={busy} onClick={() => void runImport(sampleText(s.json), s.fileName, 'Bundled sample (procedural JSON)')}>
                    Import {s.label}
                  </button>
                  <button className="link" onClick={() => downloadText(s.fileName, sampleText(s.json), 'application/json')}>
                    Download
                  </button>
                </span>
              ))}
              <span className="sample">
                <button className="btn btn-small" disabled={busy} onClick={() => void runImport(invalidSampleText(), 'invalid-example.json', 'Uploaded JSON file')}>
                  Try an invalid file
                </button>
                <button className="link" onClick={() => downloadText('invalid-example.json', invalidSampleText(), 'application/json')}>
                  Download
                </button>
              </span>
            </div>
          </div>
        </details>
      )}

      {activate && (
        <ConfirmDialog
          title={`Make ${activate.revision} active?`}
          message={
            <p>
              The viewer and forms for <b>{projectName(activate.projectId)}</b> will switch to {activate.name} <b>{activate.revision}</b>. Progress recorded on
              other revisions stays with those revisions and is not transferred.
            </p>
          }
          confirmLabel="Make active"
          busy={busy}
          onCancel={() => setActivate(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await repo.setActiveModel(activate.key);
              notify(`${activate.name} ${activate.revision} is now active.`);
              if (activate.projectId !== projectId) setProjectId(activate.projectId);
              else await refresh();
            } catch (e) {
              notify(errorMessages(e).join(' '), 'error');
            } finally {
              setBusy(false);
              setActivate(null);
            }
          }}
        />
      )}
      {errorsFor && (
        <ConfirmDialog
          title={`Import errors — ${errorsFor.sourceName}`}
          message={<ErrorList title={`${errorsFor.errors?.length ?? 0} error(s)`} errors={errorsFor.errors ?? []} />}
          confirmLabel="Close"
          onCancel={() => setErrorsFor(null)}
          onConfirm={() => setErrorsFor(null)}
        />
      )}
    </div>
  );
}

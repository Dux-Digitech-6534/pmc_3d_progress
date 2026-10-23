import { IS_FRAPPE } from '../config';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AiReaderCard } from '../components/AiReaderCard';
import { ModelViewer } from '../components/ModelViewer';
import { ConfirmDialog, ErrorList, PageHeader } from '../components/ui';
import { errorMessages } from '../data/repository';
import {
  DRAWING_ACCEPT,
  deleteDrawing,
  listDrawings,
  loadDrawing,
  reassignDrawings,
  saveDrawing,
  validateDrawing,
  type DrawingMeta,
} from '../data/drawingStore';
import {
  buildModel,
  defaultSpec,
  gridLabel,
  makeLayout,
  parseSpans,
  resizeLayout,
  openingRange,
  removeElement,
  wallOptions,
  withDefaults,
  type BuilderSpec,
  type ElementRef,
  type ColumnType,
  type FootingType,
  type OpeningKind,
  type OpeningPlacement,
  type OpeningType,
} from '../domain/modelBuilder';
import type { ElementRecord, ModelRecord } from '../domain/types';
import { TYPE_COLORS } from '../lib/colors';
import { downloadText } from '../lib/download';
import { useApp } from '../state/AppContext';

const DRAFT_KEY = 'pmc3d.v1.builder';

const readDraft = (): BuilderSpec | null => {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as BuilderSpec | null;
    return d && Array.isArray(d.layout) ? withDefaults(d) : null;
  } catch {
    return null;
  }
};

/** R01 → R02, P3 → P4; anything else gets "-2". */
const nextRevision = (rev: string) => {
  const m = /^(.*?)(\d+)$/.exec(rev);
  return m ? m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0') : `${rev}-2`;
};

export function ModelBuilder() {
  const { repo, projects, projectId, setProjectId, refresh, notify, go } = useApp();
  const [spec, setSpecState] = useState<BuilderSpec>(() => readDraft() ?? defaultSpec());
  const [xText, setXText] = useState(() => spec.xSpans.join(', '));
  const [yText, setYText] = useState(() => spec.ySpans.join(', '));
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [drawings, setDrawings] = useState<DrawingMeta[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [created, setCreated] = useState<ModelRecord | null>(null);
  const [removeDrawing, setRemoveDrawing] = useState<DrawingMeta | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  // Left panel (sticky, always on screen): drawing and live 3D preview, side by side with the form.
  const [view, setView] = useState<'split' | 'drawing' | '3d'>('split');
  const prevProjectId = useRef(spec.projectId);
  const inFlight = useRef(false); // synchronous double-click guard for Create

  const setSpec = (patch: Partial<BuilderSpec>) =>
    setSpecState((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the draft just is not remembered */
      }
      return next;
    });

  useEffect(() => {
    void repo.listModels().then(setModels);
  }, [repo, created]);

  // drawings belong to the project id typed in the form (on the server in Frappe mode, so the
  // list is loaded asynchronously; a newer request wins over an older one)
  const drawingsToken = useRef(0);
  const reloadDrawings = () => {
    const token = ++drawingsToken.current;
    void listDrawings(spec.projectId.trim())
      .then((list) => {
        if (token !== drawingsToken.current) return;
        setDrawings(list);
        setCurrent((c) => (c && list.some((d) => d.id === c) ? c : (list[0]?.id ?? null)));
      })
      .catch((e) => token === drawingsToken.current && setUploadErrors(errorMessages(e)));
  };
  useEffect(() => {
    const t = setTimeout(reloadDrawings, 250); // wait until the user stops typing the project ID
    return () => clearTimeout(t);
  }, [spec.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const nx = spec.xSpans.length + 1;
  const ny = spec.ySpans.length + 1;
  const columnCodes = spec.columnTypes.map((c) => c.code.trim()).filter(Boolean);
  const footingCodes = spec.footingTypes.map((f) => f.code.trim()).filter(Boolean);

  const result = useMemo(() => buildModel({ ...spec, drawingRefs: drawings.map((d) => d.name) }), [spec, drawings]);
  const preview = useMemo<ElementRecord[]>(
    () =>
      (result.document?.elements ?? []).map((e) => ({
        ...e,
        key: e.id,
        projectId: spec.projectId,
        modelKey: 'preview',
        modelId: spec.modelId,
        modelRevision: spec.revision,
        buildingName: spec.buildingName,
        levelName: e.levelId,
      })),
    [result.document], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const previewColors = useMemo(() => new Map(preview.map((e) => [e.id, TYPE_COLORS[e.type]])), [preview]);
  // Re-frame the camera only when the building size changes, not on every edit (door moves etc.).
  const previewFrameKey = `${spec.xSpans.join('+')}|${spec.ySpans.join('+')}|${spec.roofLevel}|${spec.foundationDepth}`;
  const previewIds = useMemo(() => new Set(preview.map((e) => e.id)), [preview]);
  // Click an element in the live preview to see its details and change or remove it.
  const [picked, setPicked] = useState<string | null>(null);
  const [undoSpec, setUndoSpec] = useState<BuilderSpec | null>(null);
  const pickedEl = picked ? preview.find((e) => e.id === picked) : undefined;
  const pickedRef = picked ? result.refs[picked] : undefined;
  const selection = useMemo(() => new Set(pickedEl ? [pickedEl.id] : []), [pickedEl]);
  /** A removal from the element panel; the previous form can be restored with Undo until the next change. */
  const undoable = useRef(false);
  const editFromPanel = (next: BuilderSpec) => {
    undoable.current = true;
    setUndoSpec(spec);
    setSpec(next);
  };
  useEffect(() => {
    if (undoable.current) undoable.current = false;
    else setUndoSpec(null);
  }, [spec]);

  const existingRevision = models.find((m) => m.projectId === spec.projectId.trim() && m.modelId === spec.modelId.trim() && m.revision === spec.revision.trim());
  const latestOfModel = models.filter((m) => m.projectId === spec.projectId.trim() && m.modelId === spec.modelId.trim() && m.status !== 'Failed').at(-1);

  function applySpans(axis: 'x' | 'y', text: string) {
    const spans = parseSpans(text);
    if (!spans) return;
    const xs = axis === 'x' ? spans : spec.xSpans;
    const ys = axis === 'y' ? spans : spec.ySpans;
    setSpec({ [axis === 'x' ? 'xSpans' : 'ySpans']: spans, layout: resizeLayout(spec.layout, xs.length + 1, ys.length + 1, columnCodes[0] ?? '') });
  }

  async function changeProjectId(id: string) {
    const from = prevProjectId.current;
    prevProjectId.current = id;
    if (!from || from === id || projects.some((p) => p.id === from)) return;
    try {
      if ((await listDrawings(from)).length) {
        await reassignDrawings(from, id);
        reloadDrawings();
      }
    } catch (e) {
      setUploadErrors(errorMessages(e));
    }
  }

  function startFrom(pid: string) {
    if (pid === '__new__') {
      const fresh = defaultSpec();
      setXText(fresh.xSpans.join(', '));
      setYText(fresh.ySpans.join(', '));
      prevProjectId.current = fresh.projectId;
      setSpecState(fresh);
      setSpec({});
      return;
    }
    const p = projects.find((x) => x.id === pid);
    if (!p) return;
    const active = models.find((m) => m.key === p.activeModelKey);
    const savedRaw = (active?.document?.model.source as { builderSpec?: Partial<BuilderSpec> } | undefined)?.builderSpec;
    const saved = savedRaw ? withDefaults(savedRaw) : undefined;
    if (saved) {
      // edit a model that was built here before: same IDs, next revision
      setXText(saved.xSpans.join(', '));
      setYText(saved.ySpans.join(', '));
      prevProjectId.current = saved.projectId;
      setSpec({ ...saved, revision: nextRevision(saved.revision) });
      notify(`Loaded ${active!.name} ${active!.revision}. Revision set to ${nextRevision(saved.revision)} — a changed model is always a new revision.`, 'info');
    } else {
      prevProjectId.current = p.id;
      setSpec({ projectId: p.id, projectName: p.name, location: p.location ?? '', revision: active ? nextRevision(active.revision) : spec.revision });
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const pid = spec.projectId.trim();
    if (!pid) return setUploadErrors(['Enter the Project ID first — drawings are kept with the project.']);
    const errs: string[] = [];
    let last: string | null = null;
    setBusy(true);
    for (const f of Array.from(files)) {
      const v = validateDrawing(f);
      if (v) {
        errs.push(v);
        continue;
      }
      try {
        last = (await saveDrawing(pid, f)).id;
      } catch (e) {
        errs.push(...errorMessages(e));
      }
    }
    setBusy(false);
    setUploadErrors(errs);
    reloadDrawings();
    if (last) {
      setCurrent(last);
      notify('Drawing saved with the project.');
    }
  }

  // Spacing text that is invalid or not yet applied (applied on blur) must not build from stale values.
  const xParsed = parseSpans(xText);
  const yParsed = parseSpans(yText);
  const spansPending =
    !xParsed || !yParsed || xParsed.join(',') !== spec.xSpans.join(',') || yParsed.join(',') !== spec.ySpans.join(',');

  async function create() {
    if (!result.document || inFlight.current || spansPending) return;
    inFlight.current = true;
    setBusy(true);
    setImportErrors([]);
    setCreated(null);
    try {
      const out = await repo.importModel({
        text: JSON.stringify(result.document, null, 2),
        sourceName: drawings.length ? `Model Builder — ${drawings.map((d) => d.name).join(', ')}` : 'Model Builder',
        sourceType: 'Model Builder (from drawing)',
      });
      if (out.ok && out.record) {
        setCreated(out.record);
        notify(`Created ${out.record.name} ${out.record.revision} — ${out.record.elementCount} elements.`);
        if (out.record.projectId !== projectId) setProjectId(out.record.projectId);
        else await refresh();
      } else {
        setImportErrors(out.errors);
        notify('The model could not be created — see the errors.', 'error');
        await refresh();
      }
    } catch (e) {
      setImportErrors(errorMessages(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const updColumn = (i: number, patch: Partial<ColumnType>) => setSpec({ columnTypes: spec.columnTypes.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  const updFooting = (i: number, patch: Partial<FootingType>) => setSpec({ footingTypes: spec.footingTypes.map((f, k) => (k === i ? { ...f, ...patch } : f)) });
  const updOpeningType = (i: number, patch: Partial<OpeningType>) => setSpec({ openingTypes: spec.openingTypes.map((o, k) => (k === i ? { ...o, ...patch } : o)) });
  const updPlacement = (i: number, patch: Partial<OpeningPlacement>) => setSpec({ openings: spec.openings.map((o, k) => (k === i ? { ...o, ...patch } : o)) });
  const walls = wallOptions(spec);
  const markCodes = spec.openingTypes.map((o) => o.mark.trim()).filter(Boolean);
  // Clear wall height (plinth top to roof beam soffit) and, per mark, the widest it can be on the walls it is placed on.
  const wallHeight = spec.roofBeam.enabled ? spec.roofLevel - spec.roofBeam.h : spec.roofLevel;
  const maxWidthFor = (o: OpeningType) => {
    const fits = spec.openings
      .filter((p) => p.mark.trim() === o.mark.trim())
      .map((p) => openingRange(spec, p))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => r.max - r.min + o.w);
    return fits.length ? Math.min(...fits) : undefined;
  };
  const cur = drawings.find((d) => d.id === current) ?? null;

  return (
    <div className="page page-wide">
      <PageHeader
        title="Model Builder"
        subtitle="Upload the project drawing (PDF or image), read the grid and schedules off it, and the 3D model with planned quantities is generated for you."
      />

      <div className="builder">
        {/* ---------------- left: drawings ---------------- */}
        <section className="card builder-drawing">
          <div className="builder-drawing-head">
            <div className="view-tabs" role="tablist" aria-label="Left panel view">
              {(
                [
                  ['split', 'Drawing + 3D'],
                  ['drawing', 'Drawing'],
                  ['3d', '3D model'],
                ] as const
              ).map(([v, label]) => (
                <button key={v} role="tab" aria-selected={view === v} className={`view-tab ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>
                  {label}
                </button>
              ))}
            </div>
            <label className={`btn btn-primary btn-small ${busy ? 'disabled' : ''}`}>
              Upload PDF / image…
              <input type="file" accept={DRAWING_ACCEPT} multiple hidden disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
            </label>
          </div>
          {uploadErrors.length > 0 && <ErrorList title="Not uploaded" errors={uploadErrors} />}

          {view !== '3d' && (
            <div className="builder-pane builder-pane-drawing">
              {drawings.length > 0 && (
                <div className="drawing-tabs">
                  {drawings.map((d) => (
                    <span key={d.id} className={`drawing-tab ${d.id === current ? 'on' : ''}`}>
                      <button className="link" onClick={() => setCurrent(d.id)} title={`${d.name} · ${(d.size / 1024 / 1024).toFixed(2)} MB`}>
                        {d.kind === 'pdf' ? '📄' : '🖼'} {d.name}
                      </button>
                      <button className="btn-icon" aria-label={`Remove ${d.name}`} onClick={() => setRemoveDrawing(d)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {cur ? (
                <DrawingView key={cur.id} meta={cur} />
              ) : (
                <label className="drawing-drop">
                  <input type="file" accept={DRAWING_ACCEPT} multiple hidden onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
                  <span className="drawing-drop-icon">⬆</span>
                  <b>Upload the structural / GA drawing</b>
                  <span className="muted small">PDF, JPG, PNG or WebP · up to 20 MB · a photo of a printed drawing also works</span>
                  <span className="muted small">It stays with project {spec.projectId || '—'} and opens here next to the form.</span>
                </label>
              )}
            </div>
          )}

          {view !== 'drawing' && (
            <div className="builder-pane builder-pane-3d" data-testid="builder-live-3d">
              {result.document && !spansPending ? (
                <>
                  <ModelViewer
                    elements={preview}
                    colors={previewColors}
                    visibleIds={previewIds}
                    selectedIds={selection}
                    showLabels={false}
                    onPick={(id) => setPicked(id)}
                    resetSignal={resetSignal}
                    frameKey={previewFrameKey}
                  />
                  <span className="pane-tag">Live 3D preview — click an element to see, change or remove it</span>
                  <button className="btn btn-small builder-preview-fit" onClick={() => setResetSignal((n) => n + 1)}>
                    Fit view
                  </button>
                  {pickedEl && pickedRef ? (
                    <BuilderElementPanel
                      el={pickedEl}
                      elRef={pickedRef}
                      spec={spec}
                      elements={preview}
                      onChange={(next) => setSpec(next)}
                      onRemove={() => {
                        editFromPanel(removeElement(spec, pickedRef));
                        setPicked(null);
                      }}
                      onClose={() => setPicked(null)}
                    />
                  ) : (
                    ((spec.omit?.length ?? 0) > 0 || undoSpec) && (
                      <div className="builder-pick-bar">
                        {undoSpec && (
                          <button
                            className="btn btn-small"
                            onClick={() => {
                              setSpec(undoSpec);
                              setUndoSpec(null);
                            }}
                          >
                            Undo last change
                          </button>
                        )}
                        {(spec.omit?.length ?? 0) > 0 && (
                          <button className="btn btn-small" onClick={() => editFromPanel({ ...spec, omit: [] })}>
                            Restore {spec.omit!.length} removed element{spec.omit!.length === 1 ? '' : 's'}
                          </button>
                        )}
                      </div>
                    )
                  )}
                </>
              ) : (
                <div className="preview-empty">
                  <b>No 3D preview yet</b>
                  <span className="muted small">
                    {spansPending
                      ? 'Finish typing the grid spacings (click outside the box).'
                      : `${result.errors.length} problem${result.errors.length === 1 ? '' : 's'} in the form (marked red in the form, all listed in section 6):`}
                  </span>
                  {!spansPending && result.errors[0] && <span className="preview-first-error">⚠ {result.errors[0]}</span>}
                </div>
              )}
            </div>
          )}

          <div className="builder-dock">
            <div className="dock-summary">
              {result.summary && !spansPending ? (
                <>
                  <span>
                    {result.summary.footings} footings · {result.summary.columns} columns · {result.summary.beams} beams · {result.summary.slabs} slab
                    {result.summary.walls > 0 && ` · ${result.summary.walls} walls · ${result.summary.doors} doors · ${result.summary.windows} windows`}
                  </span>
                  <span className="muted small">
                    Concrete {result.summary.concrete} m³{result.summary.walls > 0 && ` · Brickwork ${result.summary.brickwork} m³`}
                    {result.warnings.length > 0 && ` · ${result.warnings.length} check note${result.warnings.length === 1 ? '' : 's'} (section 6)`}
                  </span>
                </>
              ) : (
                <span className="warn-text">Fix the form to create the model.</span>
              )}
            </div>
            {created ? (
              <button className="btn btn-small" onClick={() => go('workspace')}>
                Open in 3D Workspace
              </button>
            ) : null}
            <button
              className="btn btn-primary"
              disabled={!result.document || busy || !!existingRevision || spansPending}
              title={existingRevision ? `${spec.modelId} ${spec.revision} already exists — change the revision` : undefined}
              onClick={() => void create()}
            >
              {busy ? 'Working…' : `Create model ${spec.revision}`}
            </button>
          </div>
        </section>

        {/* ---------------- right: form ---------------- */}
        <div className="builder-form">
          <AiReaderCard
            drawings={drawings}
            spec={spec}
            onApply={(next) => {
              setXText(next.xSpans.join(', '));
              setYText(next.ySpans.join(', '));
              setSpec(next);
            }}
          />
          <section className="card">
            <h2 className="card-title">1 · Project and model</h2>
            <div className="form-grid">
              <label>
                Start from
                <select value="" onChange={(e) => e.target.value && startFrom(e.target.value)}>
                  <option value="">Choose…</option>
                  <option value="__new__">New project (blank form)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Project ID
                <input value={spec.projectId} onChange={(e) => setSpec({ projectId: e.target.value })} onBlur={(e) => void changeProjectId(e.target.value.trim())} />
              </label>
              <label>
                Project name
                <input value={spec.projectName} onChange={(e) => setSpec({ projectName: e.target.value })} />
              </label>
              <label>
                Location
                <input value={spec.location ?? ''} onChange={(e) => setSpec({ location: e.target.value })} placeholder="optional" />
              </label>
              <label>
                Building name
                <input value={spec.buildingName} onChange={(e) => setSpec({ buildingName: e.target.value })} />
              </label>
              <label>
                Model ID
                <input value={spec.modelId} onChange={(e) => setSpec({ modelId: e.target.value })} />
              </label>
              <label>
                Revision
                <input value={spec.revision} onChange={(e) => setSpec({ revision: e.target.value })} aria-invalid={!!existingRevision} />
              </label>
              <label>
                Model name
                <input value={spec.modelName} onChange={(e) => setSpec({ modelName: e.target.value })} placeholder={`${spec.buildingName || 'Building'} — Structure`} />
              </label>
            </div>
            {existingRevision && (
              <p className="field-error">
                {spec.modelId} {spec.revision} already exists in this project. Revisions are never overwritten —{' '}
                <button className="link" onClick={() => setSpec({ revision: nextRevision(latestOfModel?.revision ?? spec.revision) })}>
                  use {nextRevision(latestOfModel?.revision ?? spec.revision)}
                </button>
                .
              </p>
            )}
          </section>

          <section className="card">
            <h2 className="card-title">2 · Grid (from the plan)</h2>
            <p className="muted small">Centre-to-centre distances between grid lines in mm, as written on the drawing. Separate with commas.</p>
            <div className="form-grid">
              <label>
                X spacings X1→X2→… (mm)
                <input value={xText} onChange={(e) => setXText(e.target.value)} onBlur={() => applySpans('x', xText)} aria-invalid={!parseSpans(xText)} placeholder="3230, 2115" />
              </label>
              <label>
                Y spacings Y1→Y2→… (mm)
                <input value={yText} onChange={(e) => setYText(e.target.value)} onBlur={() => applySpans('y', yText)} aria-invalid={!parseSpans(yText)} placeholder="3230" />
              </label>
            </div>
            {(!xParsed || !yParsed) && <p className="field-error">Enter positive numbers only, e.g. 3230, 2115. The model is not generated until the spacings are valid.</p>}
            <div className="grid-head">
              <span className="field-label">Columns on the grid ({nx} × {ny} points) — choose the column type at each point, “—” for none</span>
              <span>
                <button className="link" onClick={() => setSpec({ layout: makeLayout(nx, ny, columnCodes[0] ?? '') })}>
                  Fill all with {columnCodes[0] ?? '—'}
                </button>{' '}
                ·{' '}
                <button className="link" onClick={() => setSpec({ layout: makeLayout(nx, ny, '') })}>
                  Clear
                </button>
              </span>
            </div>
            <div className="grid-matrix" style={{ gridTemplateColumns: `40px repeat(${nx}, minmax(64px, 1fr))` }}>
              <span />
              {Array.from({ length: nx }, (_, x) => (
                <span key={x} className="grid-axis">
                  {gridLabel('X', x)}
                </span>
              ))}
              {Array.from({ length: ny }, (_, i) => ny - 1 - i).map((y) => (
                <Fragment key={y}>
                  <span className="grid-axis">{gridLabel('Y', y)}</span>
                  {Array.from({ length: nx }, (_, x) => {
                    const v = spec.layout[y]?.[x] ?? '';
                    return (
                      <select
                        key={x}
                        className={`grid-cell ${v ? 'on' : ''}`}
                        value={v}
                        aria-label={`Column at ${gridLabel('X', x)}/${gridLabel('Y', y)}`}
                        onChange={(e) => setSpec({ layout: spec.layout.map((row, yy) => (yy === y ? row.map((c, xx) => (xx === x ? e.target.value : c)) : row)) })}
                      >
                        <option value="">—</option>
                        {columnCodes.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">3 · Column and footing schedules</h2>
            <div className="sched-wrap">
              <table className="table compact sched">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Size X (mm)</th>
                    <th>Size Y (mm)</th>
                    <th>Footing</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {spec.columnTypes.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <input value={c.code} onChange={(e) => updColumn(i, { code: e.target.value })} style={{ width: 70 }} aria-label="Column code" />
                      </td>
                      <td>
                        <N value={c.w} onChange={(w) => updColumn(i, { w })} label="Column size X" />
                      </td>
                      <td>
                        <N value={c.d} onChange={(d) => updColumn(i, { d })} label="Column size Y" />
                      </td>
                      <td>
                        <select value={c.footing} onChange={(e) => updColumn(i, { footing: e.target.value })} aria-label="Footing for column">
                          {!footingCodes.includes(c.footing) && <option value={c.footing}>{c.footing || '—'}</option>}
                          {footingCodes.map((f) => (
                            <option key={f}>{f}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {spec.columnTypes.length > 1 && (
                          <button className="btn-icon" aria-label={`Remove ${c.code}`} onClick={() => setSpec({ columnTypes: spec.columnTypes.filter((_, k) => k !== i) })}>
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="link" onClick={() => setSpec({ columnTypes: [...spec.columnTypes, { code: `C${spec.columnTypes.length + 1}`, w: 300, d: 300, footing: footingCodes[0] ?? 'F1' }] })}>
                + Add column type
              </button>
            </div>
            <div className="sched-wrap">
              <table className="table compact sched">
                <thead>
                  <tr>
                    <th>Footing</th>
                    <th>Length (mm)</th>
                    <th>Width (mm)</th>
                    <th>Depth D (mm)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {spec.footingTypes.map((f, i) => (
                    <tr key={i}>
                      <td>
                        <input value={f.code} onChange={(e) => updFooting(i, { code: e.target.value })} style={{ width: 70 }} aria-label="Footing code" />
                      </td>
                      <td>
                        <N value={f.w} onChange={(w) => updFooting(i, { w })} label="Footing length" />
                      </td>
                      <td>
                        <N value={f.d} onChange={(d) => updFooting(i, { d })} label="Footing width" />
                      </td>
                      <td>
                        <N value={f.t} onChange={(t) => updFooting(i, { t })} label="Footing depth" />
                      </td>
                      <td>
                        {spec.footingTypes.length > 1 && (
                          <button className="btn-icon" aria-label={`Remove ${f.code}`} onClick={() => setSpec({ footingTypes: spec.footingTypes.filter((_, k) => k !== i) })}>
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="link" onClick={() => setSpec({ footingTypes: [...spec.footingTypes, { code: `F${spec.footingTypes.length + 1}`, w: 1200, d: 1200, t: 300 }] })}>
                + Add footing type
              </button>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">4 · Levels, beams and slab (from the section)</h2>
            <div className="form-grid">
              <label>
                Footing bottom below ground (mm)
                <N value={spec.foundationDepth} onChange={(foundationDepth) => setSpec({ foundationDepth })} width={120} />
              </label>
              <label>
                Roof level — slab bottom above ground (mm)
                <N value={spec.roofLevel} onChange={(roofLevel) => setSpec({ roofLevel })} width={120} />
              </label>
            </div>
            <table className="table compact sched">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Include</th>
                  <th>Width (mm)</th>
                  <th>Depth (mm)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Plinth beam (top at ground)</td>
                  <td>
                    <input type="checkbox" checked={spec.plinthBeam.enabled} onChange={(e) => setSpec({ plinthBeam: { ...spec.plinthBeam, enabled: e.target.checked } })} />
                  </td>
                  <td>
                    <N value={spec.plinthBeam.w} onChange={(w) => setSpec({ plinthBeam: { ...spec.plinthBeam, w } })} label="Plinth beam width" />
                  </td>
                  <td>
                    <N value={spec.plinthBeam.h} onChange={(h) => setSpec({ plinthBeam: { ...spec.plinthBeam, h } })} label="Plinth beam depth" />
                  </td>
                </tr>
                <tr>
                  <td>Roof beam (top at roof level)</td>
                  <td>
                    <input type="checkbox" checked={spec.roofBeam.enabled} onChange={(e) => setSpec({ roofBeam: { ...spec.roofBeam, enabled: e.target.checked } })} />
                  </td>
                  <td>
                    <N value={spec.roofBeam.w} onChange={(w) => setSpec({ roofBeam: { ...spec.roofBeam, w } })} label="Roof beam width" />
                  </td>
                  <td>
                    <N value={spec.roofBeam.h} onChange={(h) => setSpec({ roofBeam: { ...spec.roofBeam, h } })} label="Roof beam depth" />
                  </td>
                </tr>
                <tr>
                  <td>Roof slab</td>
                  <td>
                    <input type="checkbox" checked={spec.slab.enabled} onChange={(e) => setSpec({ slab: { ...spec.slab, enabled: e.target.checked } })} />
                  </td>
                  <td>
                    <span className="muted small">overhang</span> <N value={spec.slab.overhang} onChange={(overhang) => setSpec({ slab: { ...spec.slab, overhang } })} label="Slab overhang" width={70} />
                  </td>
                  <td>
                    <span className="muted small">thick</span> <N value={spec.slab.t} onChange={(t) => setSpec({ slab: { ...spec.slab, t } })} label="Slab thickness" width={70} />
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="field-label" style={{ marginTop: 12 }}>
              Reinforcement estimate (kg per m³ of concrete) — replace with BBS quantities when available, 0 = not configured
            </div>
            <div className="steel-row">
              {(['footing', 'column', 'beam', 'slab'] as const).map((k) => (
                <label key={k} className="inline">
                  <span className="muted small">{k}</span>
                  <N value={spec.steel[k]} onChange={(v) => setSpec({ steel: { ...spec.steel, [k]: v } })} width={70} />
                </label>
              ))}
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">5 · Walls, doors and windows (from the plan and elevation)</h2>
            <div className="steel-row">
              <label className="inline check">
                <input type="checkbox" checked={spec.walls.enabled} onChange={(e) => setSpec({ walls: { ...spec.walls, enabled: e.target.checked } })} /> Brick walls
              </label>
              <label className="inline">
                <span className="muted small">thickness (mm)</span>
                <N value={spec.walls.t} onChange={(t) => setSpec({ walls: { ...spec.walls, t } })} label="Wall thickness" width={70} />
              </label>
              <label className="inline check">
                <input type="checkbox" checked={spec.walls.internal} onChange={(e) => setSpec({ walls: { ...spec.walls, internal: e.target.checked } })} /> also on internal grid lines
              </label>
            </div>
            <p className="hint">
              Walls run between column faces on the grid lines, from plinth top (ground level) up to the roof beam bottom. Openings, lintels and chhajjas
              are cut into / added to them.
            </p>

            {spec.walls.enabled && (
              <>
                <div className="field-label" style={{ marginTop: 12 }}>
                  Door / window schedule (as on the drawing)
                </div>
                <div className="sched-wrap">
                  <table className="table compact sched">
                    <thead>
                      <tr>
                        <th>Mark</th>
                        <th>Type</th>
                        <th>Width (mm)</th>
                        <th>Height (mm)</th>
                        <th title="Height of the opening bottom above the floor">Sill — up / down (mm)</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {spec.openingTypes.map((o, i) => (
                        <tr key={i}>
                          <td>
                            <input value={o.mark} onChange={(e) => updOpeningType(i, { mark: e.target.value })} style={{ width: 60 }} aria-label="Opening mark" />
                          </td>
                          <td>
                            <select
                              value={o.kind}
                              aria-label="Opening type"
                              onChange={(e) => {
                                const kind = e.target.value as OpeningKind;
                                updOpeningType(i, kind === 'door' ? { kind, sill: 0 } : { kind });
                              }}
                            >
                              <option value="door">Door</option>
                              <option value="window">Window</option>
                              <option value="ventilator">Ventilator</option>
                            </select>
                          </td>
                          <td>
                            <Stepper value={o.w} onChange={(w) => updOpeningType(i, { w })} label={`${o.mark} width`} min={100} max={maxWidthFor(o)} />
                          </td>
                          <td>
                            <Stepper value={o.h} onChange={(h) => updOpeningType(i, { h })} label={`${o.mark} height`} min={100} max={wallHeight - (o.kind === 'door' ? 0 : o.sill)} />
                          </td>
                          <td>
                            {o.kind === 'door' ? (
                              <span className="muted small" title="Doors start at the floor">
                                0 (door)
                              </span>
                            ) : (
                              <Stepper value={o.sill} onChange={(sill) => updOpeningType(i, { sill })} label={`${o.mark} sill`} min={0} max={wallHeight - o.h} down="▼" up="▲" />
                            )}
                          </td>
                          <td>
                            <button className="btn-icon" aria-label={`Remove ${o.mark}`} onClick={() => setSpec({ openingTypes: spec.openingTypes.filter((_, k) => k !== i) })}>
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="hint">
                    − / + change width and height by 50 mm, ▼ / ▲ move a window down / up by 50 mm. Wall height is {wallHeight} mm (sill + height must fit). Sizes
                    belong to the mark: every {spec.openingTypes[0]?.mark ?? 'W1'} on the drawing changes together.
                  </p>
                  <button
                    className="link"
                    onClick={() => setSpec({ openingTypes: [...spec.openingTypes, { mark: `W${spec.openingTypes.length + 1}`, kind: 'window', w: 1200, h: 1200, sill: 900 }] })}
                  >
                    + Add door / window type
                  </button>
                </div>

                <div className="field-label" style={{ marginTop: 12 }}>
                  Where each opening is — the wall, and its position: mm from the wall's first grid point to the opening centre (blank = centred). ◀ ▶ move it 100 mm; on the front wall (Y1) ◀ is left and ▶ is right, as seen from the front.
                </div>
                <div className="sched-wrap">
                  <table className="table compact sched">
                    <thead>
                      <tr>
                        <th>Mark</th>
                        <th>Wall</th>
                        <th>Position (mm)</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {spec.openings.length === 0 && (
                        <tr>
                          <td colSpan={4} className="muted small">
                            No openings placed — walls will be solid.
                          </td>
                        </tr>
                      )}
                      {spec.openings.map((o, i) => {
                        // Problems the builder reported for this placement row, shown right under it.
                        const rowErrors = result.errors.filter((e) => new RegExp(`^Opening row ${i + 1}\\b`).test(e));
                        return (
                        <Fragment key={i}>
                        <tr className={rowErrors.length ? 'row-error' : undefined}>
                          <td>
                            <select value={o.mark} onChange={(e) => updPlacement(i, { mark: e.target.value })} aria-label="Opening mark">
                              {!markCodes.includes(o.mark) && <option value={o.mark}>{o.mark || '—'}</option>}
                              {markCodes.map((m) => (
                                <option key={m}>{m}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select value={o.wall} onChange={(e) => updPlacement(i, { wall: e.target.value })} aria-label="Wall">
                              {!walls.some((w) => w.key === o.wall) && <option value={o.wall}>{o.wall} (not on this grid)</option>}
                              {walls.map((w) => (
                                <option key={w.key} value={w.key}>
                                  {w.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            {(() => {
                              // Move the opening along its wall: ◀ / ▶ step 100 mm, clamped between the column faces.
                              const range = openingRange(spec, o);
                              const current = o.offset ?? range?.centre ?? null;
                              const nudge = (d: number) =>
                                range && current !== null && updPlacement(i, { offset: Math.min(Math.max(current + d, range.min), range.max) });
                              return (
                                <div className="pos-ctl">
                                  <button
                                    type="button"
                                    className="btn btn-small"
                                    aria-label="Move 100 mm towards the wall start"
                                    title="100 mm towards the first grid point"
                                    disabled={!range?.fits || current === null || current <= range.min}
                                    onClick={() => nudge(-100)}
                                  >
                                    ◀
                                  </button>
                                  <input
                                    type="number"
                                    min={range?.min ?? 0}
                                    max={range?.max}
                                    step={50}
                                    style={{ width: 80 }}
                                    placeholder={range ? `${range.centre}` : 'centred'}
                                    aria-label="Opening centre from wall start"
                                    value={o.offset ?? ''}
                                    onChange={(e) => updPlacement(i, { offset: e.target.value === '' ? null : Number(e.target.value) })}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-small"
                                    aria-label="Move 100 mm towards the wall end"
                                    title="100 mm towards the second grid point"
                                    disabled={!range?.fits || current === null || current >= range.max}
                                    onClick={() => nudge(100)}
                                  >
                                    ▶
                                  </button>
                                  <button type="button" className="link small" disabled={o.offset === null} onClick={() => updPlacement(i, { offset: null })}>
                                    Centre
                                  </button>
                                  {range && (
                                    <span className={`small ${range.fits && (o.offset === null || (o.offset >= range.min && o.offset <= range.max)) ? 'muted' : 'warn-text'}`}>
                                      {range.fits ? `${range.min}–${range.max} mm` : 'too wide for this wall'}
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          <td>
                            <button className="btn-icon" aria-label="Remove opening" onClick={() => setSpec({ openings: spec.openings.filter((_, k) => k !== i) })}>
                              ×
                            </button>
                          </td>
                        </tr>
                        {rowErrors.length > 0 && (
                          <tr className="row-error-msg">
                            <td colSpan={4}>
                              {rowErrors.map((e, k) => (
                                <div key={k}>⚠ {e.replace(/^Opening row \d+(\s*\([^)]*\))?:?\s*/, '')}</div>
                              ))}
                            </td>
                          </tr>
                        )}
                        </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  <button
                    className="link"
                    disabled={!markCodes.length || !walls.length}
                    onClick={() => setSpec({ openings: [...spec.openings, { mark: markCodes[0], wall: walls[0].key, offset: null }] })}
                  >
                    + Place an opening
                  </button>
                </div>

                <div className="steel-row" style={{ marginTop: 12 }}>
                  <label className="inline check">
                    <input type="checkbox" checked={spec.lintel.enabled} onChange={(e) => setSpec({ lintel: { ...spec.lintel, enabled: e.target.checked } })} /> RCC lintel over
                    openings
                  </label>
                  <label className="inline">
                    <span className="muted small">depth</span>
                    <N value={spec.lintel.h} onChange={(h) => setSpec({ lintel: { ...spec.lintel, h } })} label="Lintel depth" width={65} />
                  </label>
                  <label className="inline">
                    <span className="muted small">bearing each side</span>
                    <N value={spec.lintel.bearing} onChange={(bearing) => setSpec({ lintel: { ...spec.lintel, bearing } })} label="Lintel bearing" width={65} />
                  </label>
                </div>
                <div className="steel-row">
                  <label className="inline check">
                    <input type="checkbox" checked={spec.chhajja.enabled} onChange={(e) => setSpec({ chhajja: { ...spec.chhajja, enabled: e.target.checked } })} /> Chhajja on outer
                    walls
                  </label>
                  <label className="inline">
                    <span className="muted small">projection</span>
                    <N value={spec.chhajja.projection} onChange={(projection) => setSpec({ chhajja: { ...spec.chhajja, projection } })} label="Chhajja projection" width={65} />
                  </label>
                  <label className="inline">
                    <span className="muted small">thick</span>
                    <N value={spec.chhajja.t} onChange={(t) => setSpec({ chhajja: { ...spec.chhajja, t } })} label="Chhajja thickness" width={60} />
                  </label>
                  <label className="inline check">
                    <input type="checkbox" checked={spec.chhajja.overDoors} onChange={(e) => setSpec({ chhajja: { ...spec.chhajja, overDoors: e.target.checked } })} /> over doors
                    too
                  </label>
                </div>
              </>
            )}
          </section>

          <section className="card builder-result">
            <h2 className="card-title">6 · Check and create</h2>
            {result.errors.length > 0 ? (
              <ErrorList title="Fix these to generate the model" errors={result.errors} />
            ) : (
              result.summary && (
                <>
                  <div className="builder-summary">
                    <div>
                      <b>{result.summary.footings}</b>
                      <span>footings</span>
                    </div>
                    <div>
                      <b>{result.summary.columns}</b>
                      <span>columns</span>
                    </div>
                    <div>
                      <b>{result.summary.beams}</b>
                      <span>beams</span>
                    </div>
                    <div>
                      <b>{result.summary.slabs}</b>
                      <span>slab</span>
                    </div>
                    {result.summary.walls > 0 && (
                      <>
                        <div>
                          <b>{result.summary.walls}</b>
                          <span>walls</span>
                        </div>
                        <div>
                          <b>
                            {result.summary.doors} / {result.summary.windows}
                          </b>
                          <span>doors / windows</span>
                        </div>
                        <div>
                          <b>
                            {result.summary.lintels} / {result.summary.chhajjas}
                          </b>
                          <span>lintels / chhajjas</span>
                        </div>
                        <div>
                          <b>{result.summary.brickwork} m³</b>
                          <span>brickwork</span>
                        </div>
                        <div>
                          <b>{result.summary.plaster} m²</b>
                          <span>plaster</span>
                        </div>
                      </>
                    )}
                    <div>
                      <b>{result.summary.concrete} m³</b>
                      <span>concrete</span>
                    </div>
                    <div>
                      <b>{result.summary.shuttering} m²</b>
                      <span>shuttering</span>
                    </div>
                    <div>
                      <b>{result.summary.steel} kg</b>
                      <span>steel (est.)</span>
                    </div>
                  </div>
                </>
              )
            )}
            {result.warnings.length > 0 && result.errors.length === 0 && (
              <div className="alert alert-warn">
                <strong>Check</strong>
                <ul>
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {importErrors.length > 0 && <ErrorList title="Not created — nothing was changed" errors={importErrors} />}
            {created && (
              <div className="alert alert-success">
                <strong>
                  Created {created.name} {created.revision} with {created.elementCount} elements.
                </strong>
                <div className="card-actions">
                  <button className="btn btn-small btn-primary" onClick={() => go('workspace')}>
                    Open in 3D Workspace
                  </button>
                  <button className="btn btn-small" onClick={() => go('models')}>
                    Model Register
                  </button>
                </div>
              </div>
            )}
            <div className="card-actions">
              <button className="btn btn-primary" disabled={!result.document || busy || !!existingRevision || spansPending} onClick={() => void create()}>
                {busy ? 'Working…' : `Create model ${spec.revision}`}
              </button>
              <button
                className="btn"
                disabled={!result.document || spansPending}
                onClick={() => result.document && downloadText(`${spec.modelId || 'model'}-${spec.revision || 'R01'}.json`, JSON.stringify(result.document, null, 2) + '\n', 'application/json')}
              >
                Download JSON
              </button>
            </div>
            <p className="hint">
              The model is created through the same import as a JSON file: it is validated, gets its own revision in the Model Register, and progress stays tied to that revision.
            </p>
          </section>
        </div>
      </div>

      {removeDrawing && (
        <ConfirmDialog
          title={`Remove ${removeDrawing.name}?`}
          danger
          confirmLabel="Remove drawing"
          message={<p>The drawing is deleted{IS_FRAPPE ? '' : ' from this browser'}. Models already created from it are not changed.</p>}
          onCancel={() => setRemoveDrawing(null)}
          onConfirm={async () => {
            await deleteDrawing(removeDrawing.id);
            setRemoveDrawing(null);
            reloadDrawings();
          }}
        />
      )}
    </div>
  );
}

/** − value + (or ▼ ▲) control in mm, 50 mm per click, kept between min and max. Typing any value still works. */
function Stepper({
  value,
  onChange,
  label,
  min = 0,
  max,
  step = 50,
  down = '−',
  up = '+',
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  down?: string;
  up?: string;
}) {
  const v = Number.isFinite(value) ? value : 0;
  const clamp = (n: number) => Math.max(min, max === undefined ? n : Math.min(max, n));
  const out = Number.isFinite(value) && (value < min || (max !== undefined && value > max));
  return (
    <div className={`stepper ${out ? 'out' : ''}`} title={max !== undefined ? `${min}–${max} mm` : undefined}>
      <button type="button" className="btn btn-small" aria-label={`${label}: ${step} mm less`} disabled={v <= min} onClick={() => onChange(clamp(v - step))}>
        {down}
      </button>
      <N value={value} onChange={onChange} label={label} width={70} />
      <button
        type="button"
        className="btn btn-small"
        aria-label={`${label}: ${step} mm more`}
        disabled={max !== undefined && v >= max}
        onClick={() => onChange(clamp(v + step))}
      >
        {up}
      </button>
    </div>
  );
}

const KIND_LABEL: Record<ElementRef['kind'], string> = {
  column: 'Column',
  footing: 'Footing',
  beam: 'Beam',
  wall: 'Wall',
  opening: 'Door / window',
  lintel: 'Lintel',
  chhajja: 'Chhajja',
  slab: 'Roof slab',
};

/**
 * Details of the element clicked in the live 3D preview, with the form values that make it
 * (changed here or in the form — they are the same values) and a Remove button.
 */
function BuilderElementPanel({
  el,
  elRef,
  spec,
  elements,
  onChange,
  onRemove,
  onClose,
}: {
  el: ElementRecord;
  elRef: ElementRef;
  spec: BuilderSpec;
  /** All preview elements, to say how many share a size. */
  elements: ElementRecord[];
  onChange: (next: BuilderSpec) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<BuilderSpec>) => onChange({ ...spec, ...patch });
  const count = (f: (e: ElementRecord) => boolean) => elements.filter(f).length;
  const size = el.geometry.size.map((m) => Math.round(m * 1000)).join(' × ');
  const qty = Object.entries(el.plannedQuantities);
  const all = (n: number, what: string) => <p className="hint">Changes all {n} {what} — they share this size on the drawing.</p>;

  let edit: ReactNode = null;
  let removeLabel = `Remove ${KIND_LABEL[elRef.kind].toLowerCase()}`;
  let removeHint = '';
  switch (elRef.kind) {
    case 'column':
    case 'footing': {
      const code = (spec.layout[elRef.yi]?.[elRef.xi] ?? '').trim();
      const ci = spec.columnTypes.findIndex((c) => c.code.trim() === code);
      const col = spec.columnTypes[ci];
      const fi = col ? spec.footingTypes.findIndex((f) => f.code.trim() === col.footing.trim()) : -1;
      const foot = spec.footingTypes[fi];
      const sameCol = spec.layout.flat().filter((c) => c.trim() === code).length;
      const updCol = (patch: Partial<ColumnType>) => set({ columnTypes: spec.columnTypes.map((c, k) => (k === ci ? { ...c, ...patch } : c)) });
      const updFoot = (patch: Partial<FootingType>) => set({ footingTypes: spec.footingTypes.map((f, k) => (k === fi ? { ...f, ...patch } : f)) });
      edit = (
        <>
          <div className="pick-row">
            <span>Grid point</span>
            <b>
              {gridLabel('X', elRef.xi)} / {gridLabel('Y', elRef.yi)}
            </b>
          </div>
          <label className="pick-row">
            <span>Column type here</span>
            <select
              value={code}
              onChange={(e) => set({ layout: spec.layout.map((row, y) => (y === elRef.yi ? row.map((c, x) => (x === elRef.xi ? e.target.value : c)) : row)) })}
            >
              {spec.columnTypes.map((c) => (
                <option key={c.code} value={c.code.trim()}>
                  {c.code} · {c.w}×{c.d}
                </option>
              ))}
            </select>
          </label>
          {col && elRef.kind === 'column' && (
            <>
              <div className="pick-row">
                <span>{col.code} size (mm)</span>
                <span>
                  <N value={col.w} onChange={(w) => updCol({ w })} label="Column size X" width={64} /> ×{' '}
                  <N value={col.d} onChange={(d) => updCol({ d })} label="Column size Y" width={64} />
                </span>
              </div>
              {all(sameCol, `${col.code} columns`)}
            </>
          )}
          {col && elRef.kind === 'footing' && (
            <>
              <label className="pick-row">
                <span>Footing of {col.code}</span>
                <select value={col.footing.trim()} onChange={(e) => updCol({ footing: e.target.value })}>
                  {spec.footingTypes.map((f) => (
                    <option key={f.code} value={f.code.trim()}>
                      {f.code} · {f.w}×{f.d}×{f.t}
                    </option>
                  ))}
                </select>
              </label>
              {foot && (
                <div className="pick-row">
                  <span>{foot.code} L × W × D (mm)</span>
                  <span>
                    <N value={foot.w} onChange={(w) => updFoot({ w })} label="Footing length" width={58} /> ×{' '}
                    <N value={foot.d} onChange={(d) => updFoot({ d })} label="Footing width" width={58} /> ×{' '}
                    <N value={foot.t} onChange={(t) => updFoot({ t })} label="Footing depth" width={52} />
                  </span>
                </div>
              )}
              {foot && all(spec.layout.flat().filter((c) => spec.columnTypes.find((t) => t.code.trim() === c.trim())?.footing.trim() === foot.code.trim()).length, `${foot.code} footings`)}
            </>
          )}
        </>
      );
      removeLabel = elRef.kind === 'column' ? 'Remove column + its footing' : 'Remove footing + its column';
      removeHint = 'The grid point is left empty; beams and walls then run between the next columns on the line.';
      break;
    }
    case 'beam': {
      const key = elRef.tag === 'PB' ? 'plinthBeam' : 'roofBeam';
      const b = spec[key];
      edit = (
        <>
          <div className="pick-row">
            <span>{elRef.tag === 'PB' ? 'Plinth' : 'Roof'} beam W × D (mm)</span>
            <span>
              <N value={b.w} onChange={(w) => set({ [key]: { ...b, w } })} label="Beam width" width={64} /> ×{' '}
              <N value={b.h} onChange={(h) => set({ [key]: { ...b, h } })} label="Beam depth" width={64} />
            </span>
          </div>
          {all(count((e) => e.type === 'beam' && e.code.startsWith(`${elRef.tag}-`)), elRef.tag === 'PB' ? 'plinth beams' : 'roof beams')}
        </>
      );
      removeHint = 'Only this beam is removed. Restore it with "Restore removed elements".';
      break;
    }
    case 'wall': {
      const inWall = spec.openings.map((o, i) => ({ o, i })).filter(({ o }) => o.wall === elRef.wall);
      edit = (
        <>
          <div className="pick-row">
            <span>Wall thickness (mm)</span>
            <N value={spec.walls.t} onChange={(t) => set({ walls: { ...spec.walls, t } })} label="Wall thickness" width={64} />
          </div>
          {all(count((e) => e.type === 'wall'), 'walls')}
          <div className="pick-row">
            <span>Doors / windows</span>
            <span>{inWall.length ? inWall.map(({ o }) => o.mark).join(', ') : 'none'}</span>
          </div>
          {spec.openingTypes.length > 0 && (
            <div className="pick-actions">
              {spec.openingTypes.map((t) => (
                <button key={t.mark} className="btn btn-small" onClick={() => set({ openings: [...spec.openings, { mark: t.mark.trim(), wall: elRef.wall, offset: null }] })}>
                  + {t.mark} ({t.kind})
                </button>
              ))}
            </div>
          )}
        </>
      );
      removeHint = inWall.length ? `The ${inWall.length} door/window(s) in it are removed too.` : 'Only this wall is removed.';
      break;
    }
    case 'opening': {
      const p = spec.openings[elRef.row];
      const range = p ? openingRange(spec, p) : null;
      const upd = (patch: Partial<OpeningPlacement>) => set({ openings: spec.openings.map((o, k) => (k === elRef.row ? { ...o, ...patch } : o)) });
      edit = p && (
        <>
          <div className="pick-row">
            <span>Wall</span>
            <b>{p.wall}</b>
          </div>
          <label className="pick-row">
            <span>Mark</span>
            <select value={p.mark} onChange={(e) => upd({ mark: e.target.value })}>
              {spec.openingTypes.map((t) => (
                <option key={t.mark} value={t.mark.trim()}>
                  {t.mark} · {t.kind} {t.w}×{t.h}
                </option>
              ))}
            </select>
          </label>
          <div className="pick-row">
            <span>Position (mm from first grid point)</span>
            <Stepper
              value={p.offset ?? range?.centre ?? 0}
              onChange={(offset) => upd({ offset })}
              label="Opening position"
              min={range?.min ?? 0}
              max={range?.max}
              step={100}
              down="◀"
              up="▶"
            />
          </div>
          <div className="pick-actions">
            <button className="link" onClick={() => upd({ offset: null })}>
              Centre in the wall
            </button>
          </div>
        </>
      );
      removeHint = 'Its lintel and chhajja go with it.';
      break;
    }
    case 'lintel':
      edit = (
        <div className="pick-row">
          <span>Lintel depth / bearing (mm)</span>
          <span>
            <N value={spec.lintel.h} onChange={(h) => set({ lintel: { ...spec.lintel, h } })} label="Lintel depth" width={58} /> /{' '}
            <N value={spec.lintel.bearing} onChange={(bearing) => set({ lintel: { ...spec.lintel, bearing } })} label="Lintel bearing" width={58} />
          </span>
        </div>
      );
      removeHint = 'Only this lintel is removed (all lintels: untick "RCC lintel" in section 5).';
      break;
    case 'chhajja':
      edit = (
        <div className="pick-row">
          <span>Projection / thick (mm)</span>
          <span>
            <N value={spec.chhajja.projection} onChange={(projection) => set({ chhajja: { ...spec.chhajja, projection } })} label="Chhajja projection" width={58} /> /{' '}
            <N value={spec.chhajja.t} onChange={(t) => set({ chhajja: { ...spec.chhajja, t } })} label="Chhajja thickness" width={52} />
          </span>
        </div>
      );
      removeHint = 'Only this chhajja is removed.';
      break;
    case 'slab':
      edit = (
        <>
          <div className="pick-row">
            <span>Thickness (mm)</span>
            <N value={spec.slab.t} onChange={(t) => set({ slab: { ...spec.slab, t } })} label="Slab thickness" width={64} />
          </div>
          <div className="pick-row">
            <span>Overhang (mm)</span>
            <N value={spec.slab.overhang} onChange={(overhang) => set({ slab: { ...spec.slab, overhang } })} label="Slab overhang" width={64} />
          </div>
        </>
      );
      removeHint = 'Switches "Roof slab" off in section 4.';
      break;
  }

  return (
    <aside className="builder-pick" aria-label="Selected element">
      <div className="builder-pick-head">
        <div>
          <span className="muted small">{KIND_LABEL[elRef.kind]}</span>
          <h3>{el.code}</h3>
        </div>
        <button className="btn-icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="pick-row">
        <span>Size X × Y × Z (mm)</span>
        <span>{size}</span>
      </div>
      <div className="pick-row">
        <span>Level</span>
        <span>{el.levelId}</span>
      </div>
      {qty.map(([k, q]) => (
        <div className="pick-row" key={k}>
          <span>Planned {k}</span>
          <span>
            {q.quantity} {q.unit}
          </span>
        </div>
      ))}
      {el.notes && <p className="hint">{el.notes}</p>}
      <div className="builder-pick-edit">{edit}</div>
      <div className="builder-pick-foot">
        <button className="btn btn-danger btn-small" onClick={onRemove}>
          {removeLabel}
        </button>
        {removeHint && <p className="hint">{removeHint}</p>}
      </div>
    </aside>
  );
}

/** Number input in mm; an empty box is NaN so validation can report it. Kept outside the page so it keeps focus. */
function N({ value, onChange, label, width = 90 }: { value: number; onChange: (n: number) => void; label?: string; width?: number }) {
  return (
    <input type="number" min={0} step="any" value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} aria-label={label} style={{ width }} />
  );
}

/** Shows one stored drawing: PDFs in the browser's own PDF viewer, images with zoom. */
function DrawingView({ meta }: { meta: DrawingMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let u: string | null = null;
    let alive = true;
    void loadDrawing(meta).then((blob) => {
      if (!alive) return;
      if (!blob) return setMissing(true);
      u = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: meta.type }));
      setUrl(u);
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [meta.id, meta.type, meta.url]); // eslint-disable-line react-hooks/exhaustive-deps

  if (missing) return <div className="alert alert-error">This drawing could not be opened (it may have been removed). Upload it again.</div>;
  if (!url) return <div className="drawing-view muted">Loading drawing…</div>;
  if (meta.kind === 'pdf')
    return (
      <div className="drawing-view">
        <iframe title={meta.name} src={`${url}#view=FitH`} />
        <a className="link small" href={url} target="_blank" rel="noreferrer">
          Open in new tab
        </a>
      </div>
    );
  return (
    <div className="drawing-view">
      <div className="drawing-zoom">
        <button className="btn btn-small" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))} aria-label="Zoom out">
          −
        </button>
        <span className="small">{Math.round(zoom * 100)}%</span>
        <button className="btn btn-small" onClick={() => setZoom((z) => Math.min(6, z * 1.25))} aria-label="Zoom in">
          +
        </button>
        <button className="btn btn-small" onClick={() => setZoom(1)}>
          Fit
        </button>
        <a className="link small" href={url} target="_blank" rel="noreferrer">
          Open in new tab
        </a>
      </div>
      <div className="drawing-img-wrap">
        <img src={url} alt={meta.name} style={{ width: `${zoom * 100}%` }} draggable={false} />
      </div>
    </div>
  );
}

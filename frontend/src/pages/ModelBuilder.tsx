import { IS_FRAPPE } from '../config';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AiReaderCard } from '../components/AiReaderCard';
import { ModelViewer } from '../components/ModelViewer';
import { ConfirmDialog, ErrorList, PageHeader } from '../components/ui';
import { MaterialTable } from '../components/MaterialTable';
import { CONCRETE_MIXES, materialsFor, plannedOf, withNormDefaults, type MaterialNorms } from '../domain/materials';
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
  ACTIVITIES,
  blankSpec,
  buildModel,
  placeOn,
  formatSpans,
  kindOf,
  toFreeElements,
  headerErrors,
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
  type FreeElement,
  type StructureKind,
  type ColumnType,
  type FootingType,
  type OpeningKind,
  type OpeningPlacement,
  type OpeningType,
} from '../domain/modelBuilder';
import { ELEMENT_TYPES, PLANNING_STATUSES, type ElementRecord, type ElementType, type ModelRecord } from '../domain/types';
import { TYPE_COLORS } from '../lib/colors';
import { downloadText } from '../lib/download';
import { useApp } from '../state/AppContext';

const DRAFT_KEY = 'pmc3d.v1.builder';

/** Open a submitted planning in the Model Builder to correct it (same revision, so it replaces the submission). */
export function openModelInBuilder(model: ModelRecord): boolean {
  const saved = (model.document?.model.source as { builderSpec?: Partial<BuilderSpec> } | undefined)?.builderSpec;
  if (!saved) return false;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...withDefaults(saved), revision: model.revision }));
    return true;
  } catch {
    return false;
  }
}

/** Open the Model Builder on a blank form (new project): no project, so no old drawings either. */
export function startBlankBuilder() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(blankSpec()));
  } catch {
    /* storage blocked: the builder opens with its defaults */
  }
}

/** Names the preview needs while the form's own are still empty. */
const withPreviewNames = (s: BuilderSpec): BuilderSpec => ({
  ...s,
  projectId: s.projectId.trim() || 'NEW-PROJECT',
  projectName: s.projectName.trim() || 'New project',
  modelId: s.modelId.trim() || 'MODEL',
  revision: s.revision.trim() || 'R01',
  buildingName: s.buildingName.trim() || 'Building',
});

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
  const { repo, projects, projectId, setProjectId, refresh, notify, go, role } = useApp();
  // A PMC reviewer's model is approved at once; anyone else's planning waits for the PMC.
  const approvesOwn = role === 'pmc-reviewer';
  const [spec, setSpecState] = useState<BuilderSpec>(() => readDraft() ?? defaultSpec());
  const [xText, setXText] = useState(() => formatSpans(spec.xSpans));
  const [yText, setYText] = useState(() => formatSpans(spec.ySpans));
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
  // Full screen: the left panel covers the whole screen, drawing and 3D side by side.
  const [full, setFullState] = useState(false);
  const setFull = (on: boolean) => {
    setFullState(on);
    if (on) {
      setView('split');
      document.documentElement.requestFullscreen?.().catch(() => {
        /* not allowed here: the panel still fills the browser window */
      });
    } else if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  };
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    // Esc in browser full screen only leaves full screen (no keydown), so follow that too.
    const onFs = () => !document.fullscreenElement && setFullState(false);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [full]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const kind = kindOf(spec);
  const columnCodes = spec.columnTypes.map((c) => c.code.trim()).filter(Boolean);
  const footingCodes = spec.footingTypes.map((f) => f.code.trim()).filter(Boolean);

  // The 3D preview is built even while the project / model names are still empty (a new blank
  // form); "result" — used to create the model — has the missing names as errors.
  const built = useMemo(() => buildModel({ ...withPreviewNames(spec), drawingRefs: drawings.map((d) => d.name) }), [spec, drawings]);
  const result = useMemo(() => {
    const missing = headerErrors(spec);
    return missing.length ? { ...built, errors: [...missing, ...built.errors], document: null } : built;
  }, [built, spec]);
  const preview = useMemo<ElementRecord[]>(
    () =>
      (built.document?.elements ?? []).map((e) => ({
        ...e,
        key: e.id,
        projectId: spec.projectId,
        modelKey: 'preview',
        modelId: spec.modelId,
        modelRevision: spec.revision,
        buildingName: spec.buildingName,
        levelName: e.levelId,
      })),
    [built.document], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const previewColors = useMemo(() => new Map(preview.map((e) => [e.id, TYPE_COLORS[e.type]])), [preview]);
  // Re-frame the camera only when the building size changes, not on every edit (door moves etc.).
  const previewFrameKey = `${spec.xSpans.join('+')}|${spec.ySpans.join('+')}|${spec.roofLevel}|${spec.foundationDepth}`;
  const previewIds = useMemo(() => new Set(preview.map((e) => e.id)), [preview]);
  // Click an element in the live preview to see its details and change or remove it.
  const [picked, setPicked] = useState<string | null>(null);
  // an element just added by hand is selected once the preview has it
  const [pickCode, setPickCode] = useState<string | null>(null);
  // hidden in the preview only (to look inside / behind) — not removed from the model
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<ElementType>>(() => new Set());
  const [undoSpec, setUndoSpec] = useState<BuilderSpec | null>(null);
  const pickedEl = picked ? preview.find((e) => e.id === picked) : undefined;
  const pickedRef = picked ? built.refs[picked] : undefined;
  const selection = useMemo(() => new Set(pickedEl ? [pickedEl.id] : []), [pickedEl]);
  useEffect(() => {
    if (!pickCode) return;
    const el = built.document?.elements.find((e) => e.code === pickCode);
    if (el) {
      setPicked(el.id);
      setPickCode(null);
    }
  }, [built, pickCode]);

  /**
   * Add an element by hand: next to the selected one (to its right), else at the centre. In a free
   * model it joins the element list; on a template it is kept as an extra element of the spec.
   */
  function addElement(type: ElementType) {
    const listKey = kind === 'free' ? 'freeElements' : 'extraElements';
    const list = spec[listKey] ?? [];
    // on top of the selected element (in a free model its own list entry, else its box in the model)
    const on =
      kind === 'free'
        ? pickedRef?.kind === 'free'
          ? (spec.freeElements?.[pickedRef.index] ?? null)
          : null
        : pickedEl
          ? boxOf(pickedEl)
          : null;
    const placed = placeOn(type, on);
    const tag: Record<ElementType, string> = { footing: 'F', column: 'C', beam: 'B', slab: 'S', wall: 'W', lintel: 'L', chhajja: 'CH', door: 'D', window: 'WN' };
    const taken = new Set([...(built.document?.elements.map((e) => e.code) ?? []), ...list.map((e) => e.code.trim())]);
    let n = 1;
    while (taken.has(`${tag[type]}-N${n}`)) n++;
    const code = `${tag[type]}-N${n}`;
    setSpec({ [listKey]: [...list, { code, ...placed }] });
    setPickCode(code);
  }

  const hiddenAll = useMemo(
    () => new Set([...hiddenIds, ...(built.document?.elements.filter((e) => hiddenTypes.has(e.type)).map((e) => e.id) ?? [])]),
    [hiddenIds, hiddenTypes, built],
  );
  const typesPresent = useMemo(() => ELEMENT_TYPES.filter((t) => built.document?.elements.some((e) => e.type === t)), [built]);

  /** An element of the built model as a box element (mm from the model centre). */
  const boxOf = (e: Pick<ElementRecord, 'code' | 'type' | 'geometry'>, code = e.code): FreeElement => {
    const [px, py, pz] = e.geometry.position;
    const [sx, sy, sz] = e.geometry.size;
    return { code, type: e.type, x: Math.round(px * 1000), y: Math.round(-pz * 1000) + 0, z: Math.round((py - sy / 2) * 1000), l: Math.round(sx * 1000), w: Math.round(sz * 1000), h: Math.round(sy * 1000) };
  };
  const freeCode = (base: string, taken: Set<string>) => {
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  };

  /** A copy next to the element (to its right). Template elements are copied as elements added by hand. */
  function duplicate(e: ElementRecord, ref: ElementRef) {
    const listKey = ref.kind === 'free' ? 'freeElements' : 'extraElements';
    const list = spec[listKey] ?? [];
    const taken = new Set([...(built.document?.elements.map((x) => x.code) ?? []), ...list.map((x) => x.code.trim())]);
    const src = (ref.kind === 'free' || ref.kind === 'extra') && list[ref.index] ? list[ref.index] : boxOf(e);
    const code = freeCode(src.code.trim().replace(/-\d+$/, ''), taken);
    setSpec({ [listKey]: [...list, { ...src, code, x: src.x + src.l + 200 }] });
    setPickCode(code);
  }

  /**
   * Change one element of the template on its own: it leaves the template (spec.omit) and comes back as
   * an element added by hand with the same code and box, so length, width and height can be set. A
   * wall takes its doors / windows (with their lintels and chhajjas) along, as boxes.
   */
  function detach(e: ElementRecord, ref: ElementRef) {
    if (!built.document || !('code' in ref)) return;
    const extras = [...(spec.extraElements ?? [])];
    let openings = spec.openings;
    const omit = new Set(spec.omit ?? []);
    omit.add(ref.code);
    extras.push(boxOf(e));
    if (ref.kind === 'wall') {
      const rows = new Set(spec.openings.map((o, i) => (o.wall === ref.wall ? i : -1)).filter((i) => i >= 0));
      const taken = new Set([...built.document.elements.map((x) => x.code), ...extras.map((x) => x.code)]);
      for (const x of built.document.elements) {
        const r = built.refs[x.id];
        if (r && (r.kind === 'opening' || r.kind === 'lintel' || r.kind === 'chhajja') && rows.has(r.row)) {
          const code = taken.has(x.code) && x.code !== e.code ? freeCode(x.code, taken) : x.code;
          taken.add(code);
          extras.push(boxOf(x, code));
        }
      }
      openings = spec.openings.filter((_, i) => !rows.has(i));
    }
    editFromPanel({ ...spec, omit: [...omit], extraElements: extras, openings });
    setPickCode(e.code);
  }

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

  const sameRevision = models.find((m) => m.projectId === spec.projectId.trim() && m.modelId === spec.modelId.trim() && m.revision === spec.revision.trim());
  // a planning still waiting for (or returned by) the PMC is replaced by the corrected one
  const replacing = sameRevision && PLANNING_STATUSES.includes(sameRevision.status) ? sameRevision : undefined;
  const existingRevision = replacing ? undefined : sameRevision;
  const createLabel = approvesOwn ? `Approve & create ${spec.revision}` : `${replacing ? 'Resubmit' : 'Submit'} ${spec.revision} for PMC approval`;
  const latestOfModel = models.filter((m) => m.projectId === spec.projectId.trim() && m.modelId === spec.modelId.trim() && m.status !== 'Failed').at(-1);

  function applySpans(axis: 'x' | 'y', text: string) {
    const spans = parseSpans(text, axis === 'y' && kind === 'boundary');
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
      const fresh = blankSpec();
      setXText(formatSpans(fresh.xSpans));
      setYText(formatSpans(fresh.ySpans));
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
      setXText(formatSpans(saved.xSpans));
      setYText(formatSpans(saved.ySpans));
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
  const yParsed = parseSpans(yText, kind === 'boundary');
  // a free model has no grid, so its spacings never hold up the preview
  const spansPending =
    kind !== 'free' && (!xParsed || !yParsed || xParsed.join(',') !== spec.xSpans.join(',') || yParsed.join(',') !== spec.ySpans.join(','));

  /** Switch the structure type, with sensible starting values for it. */
  function setKind(next: StructureKind) {
    if (next === kind) return;
    if (next === 'free') {
      const copied = spec.freeElements?.length ? null : built.document ? toFreeElements(built.document) : [];
      setSpec({ kind: 'free', ...(copied ? { freeElements: copied } : {}) });
      if (copied?.length) notify(`The ${copied.length} elements of the current model were copied into the free model — change, add or remove them one by one.`, 'info');
      return;
    }
    if (next === 'boundary') {
      const xs = Array<number>(10).fill(3000);
      setXText(formatSpans(xs));
      setYText('');
      setSpec({
        kind: 'boundary',
        xSpans: xs,
        ySpans: [],
        layout: makeLayout(xs.length + 1, 1, columnCodes[0] ?? ''),
        roofLevel: 2100,
        roofBeam: { ...spec.roofBeam, enabled: true, h: 150 },
        slab: { ...spec.slab, enabled: false },
        walls: { ...spec.walls, enabled: true, internal: false },
        lintel: { ...spec.lintel, enabled: false },
        chhajja: { ...spec.chhajja, enabled: false },
        openings: [],
      });
      if (drawings.length) notify('Boundary wall chosen with typical values (10 panels of 3 m). Click "Read drawing with AI" to read the wall from the drawing.', 'info');
      return;
    }
    const ys = spec.ySpans.length ? spec.ySpans : [3230];
    setYText(formatSpans(ys));
    setSpec({ kind: 'building', ySpans: ys, layout: resizeLayout(spec.layout, spec.xSpans.length + 1, ys.length + 1, columnCodes[0] ?? ''), slab: { ...spec.slab, enabled: true } });
  }

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
        role,
      });
      if (out.ok && out.record) {
        setCreated(out.record);
        notify(
          out.record.status === 'Pending Approval'
            ? `${out.record.name} ${out.record.revision} sent to the PMC for approval — it becomes the 3D model once approved.`
            : `Created ${out.record.name} ${out.record.revision} — ${out.record.elementCount} elements.`,
        );
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
        <section className={`card builder-drawing ${full ? 'builder-full' : ''}`}>
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
            <div className="builder-drawing-actions">
              <button
                className="btn btn-small"
                title={full ? 'Back to the form (Esc)' : 'Drawing and 3D model side by side on the whole screen'}
                onClick={() => setFull(!full)}
              >
                {full ? '✕ Exit full screen' : '⛶ Full screen'}
              </button>
              <label className={`btn btn-primary btn-small ${busy ? 'disabled' : ''}`}>
                Upload PDF / image…
                <input type="file" accept={DRAWING_ACCEPT} multiple hidden disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
              </label>
            </div>
          </div>
          {uploadErrors.length > 0 && <ErrorList title="Not uploaded" errors={uploadErrors} />}

          <div className="builder-panes">
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
              {built.document && !spansPending ? (
                <>
                  <ModelViewer
                    elements={preview}
                    colors={previewColors}
                    visibleIds={previewIds}
                    selectedIds={selection}
                    hiddenIds={hiddenAll}
                    showLabels={false}
                    onPick={(id) => setPicked(id)}
                    resetSignal={resetSignal}
                    frameKey={previewFrameKey}
                  />
                  <span className="pane-tag">Live 3D preview — click an element to see, change or remove it</span>
                  <div className="builder-preview-tools">
                    <select
                      className="btn btn-small"
                      value=""
                      aria-label="Add an element"
                      title={pickedEl ? `Adds it on top of ${pickedEl.code} (a door / window goes into a wall)` : 'Click an element first to add the new one on top of it'}
                      onChange={(e) => e.target.value && addElement(e.target.value as ElementType)}
                    >
                      <option value="">+ Add element…</option>
                      {ELEMENT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t[0].toUpperCase() + t.slice(1)}
                        </option>
                      ))}
                    </select>
                    <select
                      className="btn btn-small"
                      value=""
                      aria-label="Show or hide element types"
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return;
                        if (v === '__all__') {
                          setHiddenIds(new Set());
                          setHiddenTypes(new Set());
                          return;
                        }
                        const t = v as ElementType;
                        setHiddenTypes((h) => {
                          const n = new Set(h);
                          if (n.has(t)) n.delete(t);
                          else n.add(t);
                          return n;
                        });
                      }}
                    >
                      <option value="">👁 Show / hide…</option>
                      {typesPresent.map((t) => (
                        <option key={t} value={t}>
                          {hiddenTypes.has(t) ? 'Show' : 'Hide'} {t}s
                        </option>
                      ))}
                      {hiddenAll.size > 0 && <option value="__all__">Show all</option>}
                    </select>
                    <button className="btn btn-small" onClick={() => setResetSignal((n) => n + 1)}>
                      Fit view
                    </button>
                  </div>
                  {pickedEl && pickedRef ? (
                    <BuilderElementPanel
                      el={pickedEl}
                      elRef={pickedRef}
                      spec={spec}
                      elements={preview}
                      auto={built.auto[pickedEl.id]}
                      onChange={(next) => setSpec(next)}
                      onRemove={() => {
                        editFromPanel(removeElement(spec, pickedRef));
                        setPicked(null);
                      }}
                      onClose={() => setPicked(null)}
                      onDuplicate={() => duplicate(pickedEl, pickedRef)}
                      onDetach={() => detach(pickedEl, pickedRef)}
                      onHide={() => {
                        setHiddenIds((h) => new Set([...h, pickedEl.id]));
                        setPicked(null);
                      }}
                    />
                  ) : (
                    ((spec.omit?.length ?? 0) > 0 || undoSpec || (spec.extraElements?.length ?? 0) > 0 || hiddenAll.size > 0) && (
                      <div className="builder-pick-bar">
                        {hiddenAll.size > 0 && (
                          <button
                            className="btn btn-small"
                            onClick={() => {
                              setHiddenIds(new Set());
                              setHiddenTypes(new Set());
                            }}
                          >
                            Show all ({hiddenAll.size} hidden)
                          </button>
                        )}
                        {(spec.extraElements?.length ?? 0) > 0 && kind !== 'free' && (
                          <span className="pane-tag pane-tag-inline">{spec.extraElements!.length} added by hand — click one to change it</span>
                        )}
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
          </div>

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
              <button className="btn btn-small" onClick={() => go(created.status === 'Active' ? 'workspace' : 'models')}>
                {created.status === 'Active' ? 'Open in 3D Workspace' : 'Open Model Register'}
              </button>
            ) : null}
            <button
              className="btn btn-primary"
              disabled={!result.document || busy || !!existingRevision || spansPending}
              title={existingRevision ? `${spec.modelId} ${spec.revision} already exists — change the revision` : undefined}
              onClick={() => void create()}
            >
              {busy ? 'Working…' : createLabel}
            </button>
          </div>
        </section>

        {/* ---------------- right: form ---------------- */}
        <div className="builder-form">
          <section className="card">
            <h2 className="card-title">What is on the drawing?</h2>
            <p className="muted small">Choose first — the AI then reads the drawing for this type.</p>
            <div className="kind-tabs" role="radiogroup" aria-label="Structure type">
              {(
                [
                  ['building', 'Building', 'Columns on a grid, beams, roof slab, walls — room, cabin, house'],
                  ['boundary', 'Boundary wall', 'Piers on a line or around a plot, plinth + top beam, wall panels, no slab'],
                  ['free', 'Free model', 'Every footing, column, beam, wall … one by one — for anything else'],
                ] as const
              ).map(([k, label, hint]) => (
                <button key={k} role="radio" aria-checked={kind === k} className={`kind-tab ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                  <b>{label}</b>
                  <span>{hint}</span>
                </button>
              ))}
            </div>
            {kind === 'free' && (
              <p className="hint">Switching to Free model copies the current model's elements, so you can start from a template and then change anything.</p>
            )}
          </section>

          <AiReaderCard
            drawings={drawings}
            spec={spec}
            onApply={(next) => {
              setXText(formatSpans(next.xSpans));
              setYText(formatSpans(next.ySpans));
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
            {(() => {
              // a model for another building going into an existing project by mistake
              const pid = spec.projectId.trim();
              const project = projects.find((p) => p.id === pid);
              const others = [...new Set(models.filter((m) => m.projectId === pid && m.status !== 'Failed' && m.modelId !== spec.modelId.trim()).map((m) => m.modelId))];
              if (!project || !others.length) return null;
              return (
                <p className="alert alert-warn small" style={{ margin: '8px 0 0' }}>
                  Project <b>{pid}</b> ({project.name}) already exists with model{others.length === 1 ? '' : 's'} <b>{others.join(', ')}</b>. This model will be
                  added to the same project. For a different building or site, use a new Project ID (Start from → New project).
                </p>
              );
            })()}
            {replacing && (
              <p className={`alert ${replacing.status === 'Returned' ? 'alert-warn' : 'alert-info'} small`} style={{ margin: '8px 0 0' }}>
                {spec.modelId} {spec.revision} is {replacing.status === 'Returned' ? 'returned by the PMC' : 'waiting for PMC approval'} — {approvesOwn ? 'approving' : 'submitting'} replaces it with this form.
                {replacing.reviewRemarks && (
                  <>
                    {' '}
                    PMC remarks: <b>{replacing.reviewRemarks}</b>
                  </>
                )}
              </p>
            )}
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


          {kind === 'free' ? (
            <FreeElementsCard spec={spec} setSpec={setSpec} />
          ) : (
          <>
          <section className="card">
            <h2 className="card-title">{kind === 'boundary' ? '2 · Pier line (from the plan)' : '2 · Grid (from the plan)'}</h2>
            <p className="muted small">
              {kind === 'boundary'
                ? 'Centre-to-centre distance between piers (pillars) in mm. A long wall: "3000*40" = 40 panels of 3000. Leave Y empty for a straight wall; with Y spacings, use "Outer edge only" for a wall around a plot.'
                : 'Centre-to-centre distances between grid lines in mm, as written on the drawing. Separate with commas; "3000*4" = four spacings of 3000.'}
            </p>
            <div className="form-grid">
              <label>
                X spacings X1→X2→… (mm)
                <input value={xText} onChange={(e) => setXText(e.target.value)} onBlur={() => applySpans('x', xText)} aria-invalid={!parseSpans(xText)} placeholder="3230, 2115" />
              </label>
              <label>
                Y spacings Y1→Y2→… (mm)
                <input value={yText} onChange={(e) => setYText(e.target.value)} onBlur={() => applySpans('y', yText)} aria-invalid={!yParsed} placeholder={kind === 'boundary' ? 'empty = straight wall' : '3230'} />
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
                {kind === 'boundary' && ny > 2 && (
                  <>
                    {' '}
                    ·{' '}
                    <button
                      className="link"
                      onClick={() => setSpec({ layout: makeLayout(nx, ny, '').map((row, y) => row.map((_, x) => (y === 0 || y === ny - 1 || x === 0 || x === nx - 1 ? (columnCodes[0] ?? '') : ''))) })}
                    >
                      Outer edge only
                    </button>
                  </>
                )}
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

          </>
          )}

          <section className="card">
            <h2 className="card-title">
              {kind === 'free' ? '3 · Steel estimate' : kind === 'boundary' ? '4 · Levels and beams (from the wall section)' : '4 · Levels, beams and slab (from the section)'}
            </h2>
            {kind !== 'free' && (
            <>
            <div className="form-grid">
              <label>
                Footing bottom below ground (mm)
                <N value={spec.foundationDepth} onChange={(foundationDepth) => setSpec({ foundationDepth })} width={120} />
              </label>
              <label>
                {kind === 'boundary' ? 'Top of wall — top of the coping beam above ground (mm)' : 'Roof level — slab bottom above ground (mm)'}
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
                  <td>{kind === 'boundary' ? 'Top / coping beam (top at wall top)' : 'Roof beam (top at roof level)'}</td>
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
                {kind !== 'boundary' && (
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
                )}
              </tbody>
            </table>
            </>
            )}
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

          {kind !== 'free' && (
          <section className="card">
            <h2 className="card-title">{kind === 'boundary' ? '5 · Wall panels and gates (from the plan and elevation)' : '5 · Walls, doors and windows (from the plan and elevation)'}</h2>
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
          )}

          <NormsCard norms={withNormDefaults(spec.materialNorms)} onChange={(materialNorms) => setSpec({ materialNorms })} />

          <section className="card builder-result">
            <h2 className="card-title">{kind === 'free' ? '4' : '6'} · Check and create</h2>
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
                  {result.summary.materials && (
                    <>
                      <h3 className="section-title" style={{ marginTop: 12 }}>Material (planned)</h3>
                      <MaterialTable planned={result.summary.materials} compact />
                    </>
                  )}
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
                {busy ? 'Working…' : createLabel}
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
  free: 'Element',
  extra: 'Element added by hand',
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
  auto,
  onChange,
  onRemove,
  onClose,
  onDuplicate,
  onDetach,
  onHide,
}: {
  el: ElementRecord;
  elRef: ElementRef;
  spec: BuilderSpec;
  /** All preview elements, to say how many share a size. */
  elements: ElementRecord[];
  /** Calculated planned quantity per activity (before typed-in values). */
  auto: Record<string, number> | undefined;
  onChange: (next: BuilderSpec) => void;
  onRemove: () => void;
  onClose: () => void;
  onDuplicate: () => void;
  /** Take this one element out of the template to change its own length / width / height. */
  onDetach: () => void;
  onHide: () => void;
}) {
  const set = (patch: Partial<BuilderSpec>) => onChange({ ...spec, ...patch });
  const count = (f: (e: ElementRecord) => boolean) => elements.filter(f).length;
  const size = el.geometry.size.map((m) => Math.round(m * 1000)).join(' × ');
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
    case 'free':
    case 'extra': {
      const listKey = elRef.kind === 'free' ? 'freeElements' : 'extraElements';
      const list = spec[listKey] ?? [];
      const fe = list[elRef.index];
      if (!fe) break;
      const upd = (patch: Partial<FreeElement>) => set({ [listKey]: list.map((x, i) => (i === elRef.index ? { ...x, ...patch } : x)) });
      edit = (
        <>
          <label className="pick-row">
            <span>Type</span>
            <select value={fe.type} onChange={(e) => upd({ type: e.target.value as ElementType })}>
              {ELEMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="pick-row">
            <span>Code</span>
            <input value={fe.code} onChange={(e) => upd({ code: e.target.value })} style={{ width: 120 }} />
          </label>
          <p className="hint">
            Move it with ◀ ▶ (left / right) and ▼ ▲ (front / back), 100 mm a click, or type the centre in mm
            {elRef.kind === 'extra' ? ' from the model centre — click a column or wall to see its position and line it up' : ''}.
          </p>
          <div className="pick-row">
            <span>Centre X (left / right)</span>
            <Stepper value={fe.x} onChange={(x) => upd({ x })} label="Centre X" min={-1e7} step={100} down="◀" up="▶" />
          </div>
          <div className="pick-row">
            <span>Centre Y (front / back)</span>
            <Stepper value={fe.y} onChange={(y) => upd({ y })} label="Centre Y" min={-1e7} step={100} down="▼" up="▲" />
          </div>
          <div className="pick-row">
            <span>Bottom level (mm)</span>
            <NS value={fe.z} onChange={(z) => upd({ z })} label="Bottom level" width={64} />
          </div>
          <div className="pick-row">
            <span>Length — left / right (mm)</span>
            <Stepper value={fe.l} onChange={(l) => upd({ l })} label="Length" min={1} step={50} />
          </div>
          <div className="pick-row">
            <span>{fe.type === 'wall' ? 'Thickness' : 'Width'} — front / back (mm)</span>
            <Stepper value={fe.w} onChange={(w) => upd({ w })} label={fe.type === 'wall' ? 'Thickness' : 'Width'} min={1} step={50} />
          </div>
          <div className="pick-row">
            <span>Height (mm)</span>
            <Stepper value={fe.h} onChange={(h) => upd({ h })} label="Height" min={1} step={50} />
          </div>
          <div className="pick-actions">
            <button className="btn btn-small" title="Turn it a quarter: a wall along left-right then runs front-back" onClick={() => upd({ l: fe.w, w: fe.l })}>
              ↻ Rotate 90°
            </button>
            <button className="btn btn-small" onClick={() => set({ [listKey]: [...list.slice(0, elRef.index + 1), copyNext(fe, list, 'x'), ...list.slice(elRef.index + 1)] })}>
              + Copy to the right
            </button>
            <button className="btn btn-small" onClick={() => set({ [listKey]: [...list.slice(0, elRef.index + 1), copyNext(fe, list, 'y'), ...list.slice(elRef.index + 1)] })}>
              + Copy behind
            </button>
          </div>
        </>
      );
      removeHint = 'Only this element is removed.';
      break;
    }
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
      {elRef.kind !== 'free' && (
        <div className="pick-row" title="Centre of the element in mm from the model centre (X right, Y back), and the level of its underside">
          <span>Centre X / Y · bottom (mm)</span>
          <span>
            {Math.round(el.geometry.position[0] * 1000)} / {Math.round(-el.geometry.position[2] * 1000) + 0} · {Math.round((el.geometry.position[1] - el.geometry.size[1] / 2) * 1000)}
          </span>
        </div>
      )}
      <div className="pick-row">
        <span>Level</span>
        <span>{el.levelId}</span>
      </div>
      <div className="pick-qty">
        <div className="pick-qty-head">
          <span>Planned quantity</span>
          <span className="muted small">Auto = calculated from the size · type to enter your own</span>
        </div>
        {ACTIVITIES.filter((a) => a.appliesTo.includes(el.type)).map((a) => {
          const typed = spec.qtyOverride?.[el.code]?.[a.code];
          const manual = typed !== undefined;
          const calc = auto?.[a.code];
          const setQty = (v: number | undefined) => {
            const forEl = { ...(spec.qtyOverride?.[el.code] ?? {}) };
            if (v === undefined) delete forEl[a.code];
            else forEl[a.code] = v;
            const all = { ...(spec.qtyOverride ?? {}) };
            if (Object.keys(forEl).length) all[el.code] = forEl;
            else delete all[el.code];
            set({ qtyOverride: all });
          };
          return (
            <div className={`pick-row ${manual ? 'pick-manual' : ''}`} key={a.code}>
              <span>
                {a.name}
                <span className="muted small"> · {manual ? `manual (auto ${calc ?? 0})` : 'auto'}</span>
              </span>
              <span className="pick-qty-input">
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={manual ? (Number.isFinite(typed) ? typed : '') : (calc ?? '')}
                  placeholder="0"
                  aria-label={`Planned ${a.name}`}
                  onChange={(e) => setQty(e.target.value === '' ? NaN : Number(e.target.value))}
                />
                <span className="muted small">{a.unit.replace('2', '²').replace('3', '³')}</span>
                {manual && (
                  <button className="link small" title={`Back to the calculated ${calc ?? 0}`} onClick={() => setQty(undefined)}>
                    ↺ Auto
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {el.notes && <p className="hint">{el.notes}</p>}
      <div className="pick-mat">
        <span className="pick-qty-head">Material (planned)</span>
        <MaterialTable planned={materialsFor(plannedOf(el), withNormDefaults(spec.materialNorms))} compact />
      </div>
      <div className="builder-pick-edit">{edit}</div>
      <div className="pick-actions pick-tools">
        <button className="btn btn-small" onClick={onDuplicate} title="A copy next to it, to the right">
          ⧉ Duplicate
        </button>
        <button className="btn btn-small" onClick={onHide} title="Hide it in this preview only — it stays in the model">
          🙈 Hide
        </button>
        {(elRef.kind === 'wall' || elRef.kind === 'beam' || elRef.kind === 'lintel' || elRef.kind === 'chhajja') && (
          <button className="btn btn-small" onClick={onDetach} title="Set the length, width and height of only this one">
            ✎ Own size for this one
          </button>
        )}
      </div>
      {(elRef.kind === 'wall' || elRef.kind === 'beam') && (
        <p className="hint">
          Its length and height come from the grid and levels. "Own size for this one" lets you set length, width and height for only this {elRef.kind}
          {elRef.kind === 'wall' ? ' (its doors / windows come along as separate pieces)' : ''}.
        </p>
      )}
      <div className="builder-pick-foot">
        <button className="btn btn-danger btn-small" onClick={onRemove}>
          {removeLabel}
        </button>
        {removeHint && <p className="hint">{removeHint}</p>}
      </div>
    </aside>
  );
}

/** A copy of a free element next to it (to the right along X, or behind along Y), with a new code. */
function copyNext(fe: FreeElement, list: FreeElement[], dir: 'x' | 'y'): FreeElement {
  const codes = new Set(list.map((x) => x.code.trim()));
  const base = fe.code.trim().replace(/-\d+$/, '') || fe.type.toUpperCase();
  let n = 2;
  while (codes.has(`${base}-${n}`)) n++;
  return { ...fe, code: `${base}-${n}`, ...(dir === 'x' ? { x: fe.x + fe.l } : { y: fe.y + fe.w }) };
}

/** Free model: the element list, one row per element (mm). */
function FreeElementsCard({ spec, setSpec }: { spec: BuilderSpec; setSpec: (patch: Partial<BuilderSpec>) => void }) {
  const list = spec.freeElements ?? [];
  const upd = (i: number, patch: Partial<FreeElement>) => setSpec({ freeElements: list.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  return (
    <section className="card">
      <h2 className="card-title">2 · Elements ({list.length})</h2>
      <p className="muted small">
        Every element as a box, in mm: <b>X</b> = centre from the left of the plan, <b>Y</b> = centre from the front (bottom edge of the plan), <b>Bottom</b> =
        level of its underside (0 = ground, negative below ground), then length (along X), width (along Y) and height. Click an element in the 3D preview to
        change it there too.
      </p>
      <div className="free-table-wrap">
        <table className="table compact sched free-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Type</th>
              <th>X</th>
              <th>Y</th>
              <th>Bottom</th>
              <th>L</th>
              <th>W</th>
              <th>H</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((fe, i) => (
              <tr key={i}>
                <td>
                  <input value={fe.code} onChange={(e) => upd(i, { code: e.target.value })} aria-label={`Element ${i + 1} code`} style={{ width: 110 }} />
                </td>
                <td>
                  <select value={fe.type} onChange={(e) => upd(i, { type: e.target.value as ElementType })} aria-label={`Element ${i + 1} type`}>
                    {ELEMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <NS value={fe.x} onChange={(x) => upd(i, { x })} label={`Element ${i + 1} X`} width={70} />
                </td>
                <td>
                  <NS value={fe.y} onChange={(y) => upd(i, { y })} label={`Element ${i + 1} Y`} width={70} />
                </td>
                <td>
                  <NS value={fe.z} onChange={(z) => upd(i, { z })} label={`Element ${i + 1} bottom`} width={70} />
                </td>
                <td>
                  <N value={fe.l} onChange={(l) => upd(i, { l })} label={`Element ${i + 1} length`} width={64} />
                </td>
                <td>
                  <N value={fe.w} onChange={(w) => upd(i, { w })} label={`Element ${i + 1} width`} width={64} />
                </td>
                <td>
                  <N value={fe.h} onChange={(h) => upd(i, { h })} label={`Element ${i + 1} height`} width={64} />
                </td>
                <td>
                  <button className="btn-icon" aria-label={`Remove element ${fe.code || i + 1}`} onClick={() => setSpec({ freeElements: list.filter((_, k) => k !== i) })}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pick-actions" style={{ marginTop: 8 }}>
        <button className="link" onClick={() => setSpec({ freeElements: [...list, { code: `E${list.length + 1}`, type: 'column', x: 0, y: 0, z: 0, l: 230, w: 230, h: 3000 }] })}>
          + Add element
        </button>
        {list.length > 0 && (
          <button className="link" onClick={() => setSpec({ freeElements: [...list, copyNext(list[list.length - 1], list, 'x')] })}>
            + Copy last element to its right
          </button>
        )}
      </div>
    </section>
  );
}

/** Material norms of the planning: standard values, changed per project when needed. */
function NormsCard({ norms, onChange }: { norms: MaterialNorms; onChange: (n: MaterialNorms) => void }) {
  const custom = !CONCRETE_MIXES[norms.concreteGrade];
  const row = (label: string, value: number, set: (v: number) => void, unit: string) => (
    <label className="inline">
      <span className="muted small">{label}</span>
      <input type="number" min={0} step="any" value={Number.isFinite(value) ? value : ''} onChange={(e) => set(e.target.value === '' ? NaN : Number(e.target.value))} style={{ width: 84 }} aria-label={label} />
      <span className="muted small">{unit}</span>
    </label>
  );
  return (
    <section className="card">
      <h2 className="card-title">Material norms</h2>
      <p className="muted small">
        Standard values (nominal mix, IS / DSR practice) are filled in. Change them when the project's specification differs — the PMC approves them with
        the planning, and cement, sand, aggregate, steel and bricks are worked out from them.
      </p>
      <div className="norms-grid">
        <div>
          <div className="field-label">Concrete — per m³</div>
          <label className="inline">
            <span className="muted small">grade</span>
            <select
              value={custom ? '__custom__' : norms.concreteGrade}
              onChange={(e) =>
                e.target.value === '__custom__'
                  ? onChange({ ...norms, concreteGrade: 'Custom' })
                  : onChange({ ...norms, concreteGrade: e.target.value, concrete: CONCRETE_MIXES[e.target.value] })
              }
            >
              {Object.keys(CONCRETE_MIXES).map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value="__custom__">Custom</option>
            </select>
          </label>
          {row('cement', norms.concrete.cementKg, (cementKg) => onChange({ ...norms, concreteGrade: 'Custom', concrete: { ...norms.concrete, cementKg } }), 'kg')}
          {row('sand', norms.concrete.sandM3, (sandM3) => onChange({ ...norms, concreteGrade: 'Custom', concrete: { ...norms.concrete, sandM3 } }), 'm³')}
          {row('aggregate', norms.concrete.aggregateM3, (aggregateM3) => onChange({ ...norms, concreteGrade: 'Custom', concrete: { ...norms.concrete, aggregateM3 } }), 'm³')}
        </div>
        <div>
          <div className="field-label">Brickwork — per m³</div>
          {row('bricks', norms.brickwork.bricks, (bricks) => onChange({ ...norms, brickwork: { ...norms.brickwork, bricks } }), 'nos')}
          {row('cement', norms.brickwork.cementKg, (cementKg) => onChange({ ...norms, brickwork: { ...norms.brickwork, cementKg } }), 'kg')}
          {row('sand', norms.brickwork.sandM3, (sandM3) => onChange({ ...norms, brickwork: { ...norms.brickwork, sandM3 } }), 'm³')}
        </div>
        <div>
          <div className="field-label">Plaster — per m²</div>
          {row('cement', norms.plaster.cementKg, (cementKg) => onChange({ ...norms, plaster: { ...norms.plaster, cementKg } }), 'kg')}
          {row('sand', norms.plaster.sandM3, (sandM3) => onChange({ ...norms, plaster: { ...norms.plaster, sandM3 } }), 'm³')}
        </div>
        <div>
          <div className="field-label">General</div>
          {row('wastage', norms.wastagePct, (wastagePct) => onChange({ ...norms, wastagePct }), '%')}
          {row('cement bag', norms.bagKg, (bagKg) => onChange({ ...norms, bagKg }), 'kg')}
        </div>
      </div>
      <p className="hint">Steel comes from the reinforcement quantity (kg) of each element; plaster is counted on both faces of a wall.</p>
    </section>
  );
}

/** Number input in mm that may be negative (positions, levels). */
function NS({ value, onChange, label, width = 90 }: { value: number; onChange: (n: number) => void; label?: string; width?: number }) {
  return (
    <input type="number" step="any" value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} aria-label={label} style={{ width }} />
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
  // null = fit: the whole drawing visible in the panel. A number = width as a share of the panel.
  const [zoom, setZoom] = useState<number | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The zoom the drawing is shown at now (when fitted: its fitted width / panel width). */
  const currentZoom = () => zoom ?? (imgRef.current && wrapRef.current ? imgRef.current.clientWidth / Math.max(1, wrapRef.current.clientWidth) : 1);
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
        <button className="btn btn-small" onClick={() => setZoom(Math.max(0.25, currentZoom() / 1.25))} aria-label="Zoom out">
          −
        </button>
        <span className="small">{zoom === null ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
        <button className="btn btn-small" onClick={() => setZoom(Math.min(6, currentZoom() * 1.25))} aria-label="Zoom in">
          +
        </button>
        <button className="btn btn-small" onClick={() => setZoom(null)} title="Whole drawing in the panel">
          Fit
        </button>
        <button className="btn btn-small" onClick={() => setZoom(1)} title="Drawing as wide as the panel">
          Fit width
        </button>
        <a className="link small" href={url} target="_blank" rel="noreferrer">
          Open in new tab
        </a>
      </div>
      <div className={`drawing-img-wrap ${zoom === null ? 'fit' : ''}`} ref={wrapRef}>
        <img ref={imgRef} src={url} alt={meta.name} style={zoom === null ? undefined : { width: `${zoom * 100}%` }} draggable={false} />
      </div>
    </div>
  );
}

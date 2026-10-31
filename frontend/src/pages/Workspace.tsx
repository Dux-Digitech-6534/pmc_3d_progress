import { useCallback, useEffect, useMemo, useState } from 'react';
import { ElementPanel } from '../components/ElementPanel';
import { ElementPicker } from '../components/ElementPicker';
import { MaterialRequiredPanel } from '../components/MaterialRequiredPanel';
import { ModelViewer } from '../components/ModelViewer';
import { EmptyState, Spinner } from '../components/ui';
import { ACTIVITY_STATUS_LABELS, computeActivityProgress, type ActivityStatus } from '../domain/progress';
import { ELEMENT_TYPES, VIEW_GROUPS, viewGroupOf, type ElementType, type ViewGroup } from '../domain/types';
import { AWAITING_COLOR, STATUS_COLORS, TYPE_COLORS, TYPE_LABELS, SELECTION_COLOR } from '../lib/colors';
import { useApp } from '../state/AppContext';

/**
 * What the workspace shows per element. Progress itself only ever counts APPROVED quantities; for the
 * site engineer and PMC reviewer, work that is submitted but not yet approved is shown as
 * "Awaiting approval" instead of "Not started" so it is clear the entry exists. The Owner sees
 * approved progress only.
 */
type ViewStatus = ActivityStatus | 'awaiting';
const STATUS_ORDER: ViewStatus[] = ['not-started', 'awaiting', 'in-progress', 'complete', 'not-configured', 'not-applicable'];
const VIEW_LABELS: Record<ViewStatus, string> = { ...ACTIVITY_STATUS_LABELS, awaiting: 'Awaiting approval' };
const VIEW_COLORS: Record<ViewStatus, string> = { ...STATUS_COLORS, awaiting: AWAITING_COLOR };

/**
 * The 3D screen. Two screens use it: "work" (tick elements and record the work done) and "material"
 * (tick elements and see the material they need). Each keeps its own ticks.
 */
export function Workspace({ mode }: { mode: 'work' | 'material' }) {
  const { data, loading, loadError, selection: workSelection, setSelection: setWorkSelection, go, role } = useApp();
  const [materialSelection, setMaterialSelection] = useState<Set<string>>(() => new Set());
  const selection = mode === 'work' ? workSelection : materialSelection;
  const setSelection = mode === 'work' ? setWorkSelection : setMaterialSelection;
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ElementType>('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [view, setView] = useState<string>('CONC'); // 'type' or an activity code
  const [statusFilter, setStatusFilter] = useState<'all' | ViewStatus>('all');
  const [showLabels, setShowLabels] = useState(true);
  const [resetSignal, setResetSignal] = useState(0);
  // hidden in the 3D view only (to look inside the building) — nothing changes in the model or progress
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<ViewGroup>>(() => new Set());
  // the element whose details are open in the right panel (click in the list or the 3D view)
  const [focusId, setFocusId] = useState<string | null>(null);

  const elements = useMemo(() => data?.elements ?? [], [data?.elements]);
  const hiddenAll = useMemo(
    () => new Set([...hiddenIds, ...elements.filter((e) => hiddenTypes.has(viewGroupOf(e))).map((e) => e.id)]),
    [hiddenIds, hiddenTypes, elements],
  );
  const typesPresent = useMemo(() => VIEW_GROUPS.filter((t) => elements.some((e) => viewGroupOf(e) === t)), [elements]);
  const activities = useMemo(() => data?.model?.document?.activities ?? [], [data?.model]);
  const entries = useMemo(() => data?.entries ?? [], [data?.entries]);
  const viewActivity = activities.find((a) => a.code === view) ?? null;

  // Fall back to a valid view if the model's activities differ.
  useEffect(() => {
    if (view !== 'type' && activities.length && !activities.some((a) => a.code === view)) setView(activities[0].code);
  }, [activities, view]);

  const statusById = useMemo(() => {
    const m = new Map<string, ViewStatus>();
    if (viewActivity) {
      for (const el of elements) {
        const p = computeActivityProgress(el, viewActivity, entries);
        const awaiting = role !== 'owner' && p.pendingReview > 0 && (p.status === 'not-started' || p.status === 'in-progress');
        m.set(el.id, awaiting ? 'awaiting' : p.status);
      }
    }
    return m;
  }, [elements, entries, viewActivity, role]);

  const colors = useMemo(() => {
    const m = new Map<string, string>();
    for (const el of elements) m.set(el.id, viewActivity ? VIEW_COLORS[statusById.get(el.id)!] : TYPE_COLORS[el.type]);
    return m;
  }, [elements, statusById, viewActivity]);

  const levels = useMemo(() => data?.model?.document?.levels ?? [], [data?.model]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return elements.filter(
      (el) =>
        (typeFilter === 'all' || el.type === typeFilter) &&
        (levelFilter === 'all' || el.levelId === levelFilter) &&
        (statusFilter === 'all' || !viewActivity || statusById.get(el.id) === statusFilter) &&
        (!q || el.code.toLowerCase().includes(q) || el.id.toLowerCase().includes(q) || el.type.includes(q)),
    );
  }, [elements, typeFilter, levelFilter, statusFilter, viewActivity, statusById, search]);
  const visibleIds = useMemo(() => new Set(visible.map((e) => e.id)), [visible]);

  const selectedEls = useMemo(() => elements.filter((e) => selection.has(e.id)), [elements, selection]);
  const hiddenSelected = selectedEls.filter((e) => !visibleIds.has(e.id)).length;

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
    },
    [selection, setSelection],
  );

  // Click in 3D: show that element's details; Ctrl/⌘-click ticks it.
  const onPick = useCallback(
    (id: string | null, additive: boolean) => {
      if (!id) return; // clicking empty space keeps the selection; use Clear or Esc
      if (additive) toggle(id);
      else setFocusId(id);
    },
    [toggle],
  );
  const focusEl = focusId ? (elements.find((e) => e.id === focusId) ?? null) : null;
  // the 3D highlights the ticked elements and the one whose details are open
  const highlighted = useMemo(() => (focusId ? new Set([...selection, focusId]) : selection), [selection, focusId]);

  // Esc closes the details, then clears the ticks (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !document.querySelector('.modal')) {
        if (focusId) setFocusId(null);
        else setSelection(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSelection, focusId]);

  const legendCounts = useMemo(() => {
    const c: Record<ViewStatus, number> = { 'not-started': 0, awaiting: 0, 'in-progress': 0, complete: 0, 'not-configured': 0, 'not-applicable': 0 };
    statusById.forEach((s) => (c[s] += 1));
    return c;
  }, [statusById]);

  if (loadError) return <EmptyState title="Could not load project data">{loadError}</EmptyState>;
  if (!data) return <Spinner label="Loading project…" />;
  if (!data.model) {
    return (
      <EmptyState
        title={`No approved model for ${data.project.name} yet`}
        action={
          <button className="btn btn-primary" onClick={() => go('models')}>
            Upload 3D + BOQ
          </button>
        }
      >
        Upload the project's 3D + BOQ file — it becomes the 3D model that work done and material required use.
      </EmptyState>
    );
  }

  const filters = (
    <>
      <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} aria-label="Level">
        <option value="all">All levels</option>
        {levels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
        disabled={!viewActivity}
        aria-label="Activity status"
        title={viewActivity ? `Status of ${viewActivity.name}` : 'Choose an activity in "Colour by" to filter by status'}
      >
        <option value="all">{viewActivity ? `Any ${viewActivity.name.toLowerCase()} status` : 'Any status'}</option>
        {STATUS_ORDER.map((s) => (
          <option key={s} value={s}>
            {VIEW_LABELS[s]}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <div className="workspace">
      <section className="ws-center">
        <div className="viewer-toolbar">
          <label className="inline">
            Colour by
            <select value={view} onChange={(e) => setView(e.target.value)} aria-label="Colour by">
              {activities.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name} progress
                </option>
              ))}
              <option value="type">Element type</option>
            </select>
          </label>
          <button className="btn btn-small" onClick={() => setResetSignal((n) => n + 1)}>
            Reset camera
          </button>
          <label className="inline check">
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Labels
          </label>
          <select
            className="btn btn-small"
            value=""
            aria-label="Show or hide element types"
            title="Hide the roof, beams … to look inside — only in this view"
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              if (v === '__all__') {
                setHiddenIds(new Set());
                setHiddenTypes(new Set());
                return;
              }
              const t = v as ViewGroup;
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
                {hiddenTypes.has(t) ? 'Show' : 'Hide'} {t === 'stair' ? 'stair' : TYPE_LABELS[t].toLowerCase()}s
              </option>
            ))}
            {hiddenAll.size > 0 && <option value="__all__">Show all</option>}
          </select>
          <button
            className="btn btn-small"
            disabled={!selection.size}
            title="Hide the selected elements in this view"
            onClick={() => {
              setHiddenIds((h) => new Set([...h, ...selection]));
              setSelection(new Set());
            }}
          >
            Hide selected
          </button>
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
          <span className="spacer" />
          <span className="sel-count" data-testid="selected-count">
            {selection.size} ticked
            {hiddenSelected > 0 && <span className="muted"> ({hiddenSelected} hidden by filters)</span>}
          </span>
          <button className="btn btn-small" onClick={() => setSelection(new Set())} disabled={!selection.size}>
            Clear ticks
          </button>
        </div>
        <div className="viewer-wrap">
          {loading && <div className="viewer-loading">Refreshing…</div>}
          <ModelViewer
            elements={elements}
            colors={colors}
            visibleIds={visibleIds}
            selectedIds={highlighted}
            hiddenIds={hiddenAll}
            showLabels={showLabels}
            onPick={onPick}
            resetSignal={resetSignal}
            frameKey={data.model.key}
          />
          <div className="legend" aria-label="Legend">
            {viewActivity ? (
              <>
                <div className="legend-title">
                  {viewActivity.name} {role === 'owner' ? '(approved only)' : '— counts approved work only'}
                </div>
                {STATUS_ORDER.filter((s) => (s !== 'not-applicable' && s !== 'awaiting') || legendCounts[s] > 0).map((s) => (
                  <div key={s} className="legend-row">
                    <span className="swatch" style={{ background: VIEW_COLORS[s] }} />
                    {VIEW_LABELS[s]} <span className="muted">({legendCounts[s]})</span>
                  </div>
                ))}
              </>
            ) : (
              <>
                <div className="legend-title">Element type</div>
                {ELEMENT_TYPES.filter((t) => elements.some((e) => e.type === t)).map((t) => (
                  <div key={t} className="legend-row">
                    <span className="swatch" style={{ background: TYPE_COLORS[t] }} />
                    {TYPE_LABELS[t]}
                  </div>
                ))}
              </>
            )}
            <div className="legend-row">
              <span className="swatch swatch-sel" style={{ borderColor: SELECTION_COLOR }} />
              Selected
            </div>
          </div>
          <div className="viewer-help">Drag: rotate · Right-drag / Shift: pan · Wheel: zoom · Click: details · Ctrl/⌘-click: tick · Esc: close / clear</div>
        </div>
      </section>

      <aside className="ws-right" aria-label="Selected element">
        <div className="ws-right-title">{mode === 'work' ? 'Work done' : 'Material required'}</div>
        <div className="ws-right-body">
          {focusEl ? (
            <div className="focus-view">
              <div className="focus-bar">
                <button className="btn btn-small" onClick={() => setFocusId(null)}>
                  ← Back to list
                </button>
                <label className="check focus-tick">
                  <input type="checkbox" checked={selection.has(focusEl.id)} onChange={() => toggle(focusEl.id)} /> Ticked
                </label>
              </div>
              {mode === 'work' ? (
                <ElementPanel
                  selected={[focusEl]}
                  activities={activities}
                  entries={entries}
                  allEntries={data.allEntries}
                  projectName={data.project.name}
                  modelKey={data.model.key}
                  onOpen={setFocusId}
                />
              ) : (
                <MaterialRequiredPanel selected={[focusEl]} entries={entries} shown={0} onTickShown={() => undefined} />
              )}
            </div>
          ) : (
            <>
              <ElementPicker
                elements={elements}
                listed={visible}
                selection={selection}
                onChange={setSelection}
                onOpen={setFocusId}
                type={typeFilter}
                onType={setTypeFilter}
                search={search}
                onSearch={setSearch}
                filters={filters}
                statusOf={(id) => {
                  const st = statusById.get(id);
                  return st ? { label: VIEW_LABELS[st], color: VIEW_COLORS[st] } : undefined;
                }}
              />
              {mode === 'work' ? (
                <ElementPanel
                  selected={selectedEls}
                  activities={activities}
                  entries={entries}
                  allEntries={data.allEntries}
                  projectName={data.project.name}
                  modelKey={data.model.key}
                  onOpen={setFocusId}
                />
              ) : (
                <MaterialRequiredPanel
                  selected={selectedEls}
                  entries={entries}
                  shown={visible.length}
                  onTickShown={() => setSelection(new Set([...selection, ...visible.map((e) => e.id)]))}
                />
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

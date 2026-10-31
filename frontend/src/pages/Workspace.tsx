import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ElementPanel } from '../components/ElementPanel';
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

export function Workspace() {
  const { data, loading, loadError, selection, setSelection, go, role } = useApp();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ElementType>('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [view, setView] = useState<string>('CONC'); // 'type' or an activity code
  const [statusFilter, setStatusFilter] = useState<'all' | ViewStatus>('all');
  const [showLabels, setShowLabels] = useState(true);
  const [resetSignal, setResetSignal] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  // hidden in the 3D view only (to look inside the building) — nothing changes in the model or progress
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<ViewGroup>>(() => new Set());

  const elements = useMemo(() => data?.elements ?? [], [data?.elements]);
  const hiddenAll = useMemo(() => new Set([...hiddenIds, ...elements.filter((e) => hiddenTypes.has(viewGroupOf(e))).map((e) => e.id)]), [hiddenIds, hiddenTypes, elements]);
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
  const selectOnly = useCallback((id: string) => setSelection(new Set([id])), [setSelection]);

  const onPick = useCallback(
    (id: string | null, additive: boolean) => {
      if (!id) return; // clicking empty space keeps the selection; use Clear or Esc
      if (additive) toggle(id);
      else selectOnly(id);
    },
    [toggle, selectOnly],
  );

  // Esc clears the selection (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !document.querySelector('.modal')) {
        setSelection(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSelection]);

  // Keep the list in sync with 3D picks: scroll the (last) selected row into view.
  useEffect(() => {
    const last = [...selection].pop();
    if (!last) return;
    listRef.current?.querySelector(`[data-element-id="${CSS.escape(last)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selection]);

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
            Open Model Register
          </button>
        }
      >
        No approved model yet. A planning made in the Model Builder becomes the 3D model once the PMC Reviewer approves it in the Model Register.
      </EmptyState>
    );
  }

  return (
    <div className="workspace">
      <aside className="ws-left" aria-label="Elements">
        <div className="ws-filters">
          <input type="search" placeholder="Search code or ID…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search elements" />
          <div className="filter-row">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} aria-label="Element type">
              <option value="all">All types</option>
              {ELEMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} aria-label="Level">
              <option value="all">All levels</option>
              {levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            disabled={!viewActivity}
            aria-label="Activity status"
            title={viewActivity ? `Status of ${viewActivity.name}` : 'Choose an activity in "Colour by" to filter by status'}
          >
            <option value="all">{viewActivity ? `Any ${viewActivity.name.toLowerCase()} status` : 'Status filter needs an activity view'}</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {VIEW_LABELS[s]}
              </option>
            ))}
          </select>
          <div className="list-tools">
            <span className="muted small">
              {visible.length} of {elements.length} shown
            </span>
            <button className="link" onClick={() => setSelection(new Set([...selection, ...visible.map((e) => e.id)]))} disabled={!visible.length}>
              Select shown
            </button>
          </div>
        </div>
        <ul className="el-list" ref={listRef}>
          {visible.length === 0 && <li className="muted small pad">No elements match the filters.</li>}
          {visible.map((el) => {
            const sel = selection.has(el.id);
            const st = statusById.get(el.id);
            return (
              <li key={el.id} data-element-id={el.id} className={sel ? 'sel' : ''}>
                <input type="checkbox" checked={sel} onChange={() => toggle(el.id)} aria-label={`Select ${el.code} (multi-select)`} />
                <button
                  className="el-row"
                  onClick={(e) => (e.ctrlKey || e.metaKey ? toggle(el.id) : selectOnly(el.id))}
                  title={`${el.id} — Ctrl/⌘-click to add to selection`}
                >
                  <span className="el-code">{el.code}</span>
                  <span className={`type-tag type-${el.type}`}>{TYPE_LABELS[el.type]}</span>
                  {st && (
                    <span className="el-status" title={`${viewActivity?.name}: ${VIEW_LABELS[st]}`}>
                      <span className="dot" style={{ background: VIEW_COLORS[st] }} />
                      {VIEW_LABELS[st]}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

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
            {selection.size} selected
            {hiddenSelected > 0 && <span className="muted"> ({hiddenSelected} hidden by filters)</span>}
          </span>
          <button className="btn btn-small" onClick={() => setSelection(new Set())} disabled={!selection.size}>
            Clear selection
          </button>
        </div>
        <div className="viewer-wrap">
          {loading && <div className="viewer-loading">Refreshing…</div>}
          <ModelViewer
            elements={elements}
            colors={colors}
            visibleIds={visibleIds}
            selectedIds={selection}
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
          <div className="viewer-help">Drag: rotate · Right-drag / Shift: pan · Wheel: zoom · Click: select · Ctrl/⌘-click: multi-select · Esc: clear</div>
        </div>
      </section>

      <aside className="ws-right" aria-label="Selected element">
        <ElementPanel
          selected={selectedEls}
          activities={activities}
          entries={entries}
          allEntries={data.allEntries}
          projectName={data.project.name}
          modelKey={data.model.key}
          onSelectOnly={selectOnly}
        />
      </aside>
    </div>
  );
}

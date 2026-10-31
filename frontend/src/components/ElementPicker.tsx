import { useMemo, type ReactNode } from 'react';
import { ELEMENT_TYPES, type ElementRecord, type ElementType } from '../domain/types';
import { TYPE_COLORS, TYPE_LABELS } from '../lib/colors';

/**
 * Pick elements in the right panel: search / level / status filters, a tile per element type
 * (Footing, Column …) that opens the list of that type. The checkbox ticks an element (the workspace
 * selection, also shown in 3D); clicking the element's name opens its details.
 */
export function ElementPicker({
  elements,
  listed,
  selection,
  onChange,
  onOpen,
  type,
  onType,
  search,
  onSearch,
  filters,
  statusOf,
}: {
  /** All elements of the model (tile counts). */
  elements: ElementRecord[];
  /** Elements that pass the filters (the list). */
  listed: ElementRecord[];
  selection: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Show the details of an element. */
  onOpen: (id: string) => void;
  type: 'all' | ElementType;
  onType: (t: 'all' | ElementType) => void;
  search: string;
  onSearch: (s: string) => void;
  /** Level and status filters. */
  filters: ReactNode;
  statusOf?: (id: string) => { label: string; color: string } | undefined;
}) {
  const byType = useMemo(() => {
    const m = new Map<ElementType, ElementRecord[]>();
    for (const el of elements) m.set(el.type, [...(m.get(el.type) ?? []), el]);
    return ELEMENT_TYPES.filter((t) => m.has(t)).map((t) => ({ type: t, els: m.get(t)! }));
  }, [elements]);

  const showList = type !== 'all' || search.trim() !== '';
  const allTicked = listed.length > 0 && listed.every((e) => selection.has(e.id));
  const set = (ids: string[], on: boolean) => {
    const next = new Set(selection);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    onChange(next);
  };

  return (
    <div className="picker">
      <input type="search" placeholder="Search element code…" value={search} onChange={(e) => onSearch(e.target.value)} aria-label="Search elements" />
      <div className="picker-filters">{filters}</div>
      <div className="picker-tiles" role="group" aria-label="Element types">
        {byType.map(({ type: t, els }) => {
          const n = els.filter((e) => selection.has(e.id)).length;
          return (
            <button key={t} className={`picker-tile ${type === t ? 'open' : ''} ${n ? 'has' : ''}`} onClick={() => onType(type === t ? 'all' : t)} aria-expanded={type === t}>
              <span className="swatch" style={{ background: TYPE_COLORS[t] }} aria-hidden />
              <span className="picker-tile-name">{TYPE_LABELS[t]}</span>
              <span className="picker-tile-count">{n ? `${n} / ${els.length}` : els.length}</span>
            </button>
          );
        })}
      </div>

      {showList && (
        <div className="picker-list">
          <div className="picker-list-head">
            <b>{type === 'all' ? 'Search results' : `${TYPE_LABELS[type]}s`}</b>
            {listed.length > 0 && (
              <button className="link" onClick={() => set(listed.map((e) => e.id), !allTicked)}>
                {allTicked ? 'Untick all' : 'Tick all'} ({listed.length})
              </button>
            )}
            <button
              className="link"
              onClick={() => {
                onType('all');
                onSearch('');
              }}
            >
              Close
            </button>
          </div>
          {listed.length === 0 ? (
            <p className="muted small pad">No elements match.</p>
          ) : (
            <ul>
              {listed.map((el) => {
                const st = statusOf?.(el.id);
                const on = selection.has(el.id);
                return (
                  <li key={el.id} className={on ? 'on' : ''} data-element-id={el.id}>
                    <input type="checkbox" checked={on} onChange={() => set([el.id], !on)} aria-label={`Tick ${el.code}`} />
                    <button className="picker-el" onClick={() => onOpen(el.id)} title="Show details">
                      <span className="el-code">{el.code}</span>
                      <span className="muted small">{type === 'all' ? TYPE_LABELS[el.type] : el.levelName}</span>
                      {st && (
                        <span className="el-status">
                          <span className="dot" style={{ background: st.color }} />
                          {st.label}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {selection.size > 0 && (
        <div className="picker-sel">
          <span>
            <b>{selection.size}</b> ticked
          </span>
          <button className="link" onClick={() => onChange(new Set())}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

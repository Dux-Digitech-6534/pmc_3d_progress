import { computeActivityProgress, QTY_EPSILON, roundQty } from './progress';
import { inWorkOrder } from './sequence';
import { activityApplies, type ActivityDef, type ElementRecord, type ElementType, type ProgressEntry } from './types';

/**
 * Read-only reports for management. Nothing here changes data.
 *
 * 'approved'     = only work the PMC has approved (the default; same rule as progress everywhere else).
 * 'with-pending' = approved + work sent for approval and not yet reviewed.
 */
export type CountMode = 'approved' | 'with-pending';

const counts = (e: Pick<ProgressEntry, 'status'>, mode: CountMode) => e.status === 'Approved' || (mode === 'with-pending' && e.status === 'Submitted');

/** "Office – Plinth – F1": the element with its building and floor, as people say it on site. */
export const elementLabel = (el: Pick<ElementRecord, 'buildingName' | 'levelName' | 'code'>) =>
  [el.buildingName, el.levelName, el.code].filter(Boolean).join(' – ');

export const ELEMENT_TYPE_LABELS: Record<ElementType, string> = {
  footing: 'Footing',
  column: 'Column',
  beam: 'Beam',
  slab: 'Slab',
  wall: 'Wall',
  lintel: 'Lintel',
  chhajja: 'Chhajja',
  door: 'Door',
  window: 'Window',
};

// ---------------------------------------------------------------- dates

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export type RangePreset = 'today' | 'last10' | 'month' | 'all' | 'custom';

/** From/To dates (YYYY-MM-DD, both inclusive) of a preset; '' = open end. */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, today: Date = new Date()): { from: string; to: string } {
  const t = ymd(today);
  if (preset === 'today') return { from: t, to: t };
  if (preset === 'last10') {
    const d = new Date(today);
    d.setDate(d.getDate() - 9);
    return { from: ymd(d), to: t };
  }
  if (preset === 'month') return { from: `${t.slice(0, 8)}01`, to: t };
  return { from: '', to: '' };
}

// ---------------------------------------------------------------- executive summary

export interface SummaryFilter {
  from?: string;
  to?: string;
  /** Only elements of this building; empty = all buildings. */
  buildingId?: string;
  mode: CountMode;
}

export interface SummaryGroup {
  key: string;
  /** e.g. ["Office", "Plinth"] or ["Footing"]. */
  label: string[];
  /** activity code → quantity in the activity's own unit. */
  qty: Record<string, number>;
}

export interface ExecutiveSummary {
  /** Activities that have any work in the period, in site order. */
  activities: ActivityDef[];
  totals: Record<string, number>;
  byFloor: SummaryGroup[];
  byType: SummaryGroup[];
  /** Entries counted. */
  entries: number;
  /** Days with work in the period. */
  days: number;
  /** Elements with any work in the period. */
  elements: number;
}

/**
 * How much work was done in a period: per activity (m³ concrete, kg steel, m² shuttering …), and the
 * same split by building + floor and by element type. Quantities of different units are never added.
 * Entries of elements that are not in the current model revision are left out (they have no building/floor).
 */
export function executiveSummary(elements: ElementRecord[], entries: ProgressEntry[], activities: ActivityDef[], f: SummaryFilter): ExecutiveSummary {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const acts = new Map(activities.map((a) => [a.code, a]));
  const totals: Record<string, number> = {};
  const floors = new Map<string, SummaryGroup>();
  const types = new Map<string, SummaryGroup>();
  const days = new Set<string>();
  const touched = new Set<string>();
  let n = 0;

  const add = (map: Map<string, SummaryGroup>, key: string, label: string[], code: string, q: number) => {
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, label, qty: {} }));
    g.qty[code] = (g.qty[code] ?? 0) + q;
  };

  for (const e of entries) {
    if (!counts(e, f.mode)) continue;
    if (f.from && e.date < f.from) continue;
    if (f.to && e.date > f.to) continue;
    const el = byId.get(e.elementId);
    const a = acts.get(e.activityCode);
    if (!el || !a || e.unit !== a.unit || !Number.isFinite(e.quantity) || e.quantity <= 0) continue;
    if (f.buildingId && el.buildingId !== f.buildingId) continue;
    n += 1;
    days.add(e.date);
    touched.add(el.id);
    totals[a.code] = (totals[a.code] ?? 0) + e.quantity;
    add(floors, `${el.buildingId}|${el.levelId}`, [el.buildingName, el.levelName], a.code, e.quantity);
    add(types, el.type, [ELEMENT_TYPE_LABELS[el.type] ?? el.type], a.code, e.quantity);
  }

  const round = (r: Record<string, number>) => {
    for (const k of Object.keys(r)) r[k] = roundQty(r[k]);
    return r;
  };
  // floors in model order (buildings, then levels as listed), types in the usual order
  const order = new Map<string, number>();
  elements.forEach((el, i) => {
    const k = `${el.buildingId}|${el.levelId}`;
    if (!order.has(k)) order.set(k, i);
  });
  const typeOrder = Object.keys(ELEMENT_TYPE_LABELS);
  return {
    activities: inWorkOrder(activities.filter((a) => (totals[a.code] ?? 0) > QTY_EPSILON)),
    totals: round(totals),
    byFloor: [...floors.values()].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)).map((g) => ({ ...g, qty: round(g.qty) })),
    byType: [...types.values()].sort((a, b) => typeOrder.indexOf(a.key) - typeOrder.indexOf(b.key)).map((g) => ({ ...g, qty: round(g.qty) })),
    entries: n,
    days: days.size,
    elements: touched.size,
  };
}

// ---------------------------------------------------------------- category-wise status

export interface ElementStage {
  element: ElementRecord;
  /** Bucket key: 'complete' | 'not-started' | 'no-plan' | '<code>:done' | '<code>:doing'. */
  stage: string;
  /** "Complete", "Reinforcement done", "Shuttering in progress", "Not started", "No planned quantity". */
  label: string;
  /** activity code → % done (null = not planned for this element). */
  percent: Record<string, number | null>;
}

export interface StageBucket {
  stage: string;
  label: string;
  elements: ElementRecord[];
}

export interface CategoryStatus {
  /** Activities of this element type, in site order. */
  activities: ActivityDef[];
  rows: ElementStage[];
  /** Furthest stage first: Complete, … , Not started, No planned quantity. Empty buckets left out. */
  buckets: StageBucket[];
}

/**
 * Where each element of one type stands, e.g. footings: "10 Complete · 5 Reinforcement done ·
 * 2 Shuttering in progress · 8 Not started". An element's stage is the LAST activity in site order
 * with any work counted: fully done → "<activity> done", partly → "<activity> in progress".
 */
export function categoryStatus(elements: ElementRecord[], entries: ProgressEntry[], activities: ActivityDef[], type: ElementType, mode: CountMode, buildingId?: string): CategoryStatus {
  const els = elements.filter((e) => e.type === type && (!buildingId || e.buildingId === buildingId));
  const acts = inWorkOrder(activities.filter((a) => activityApplies(a, type)));
  const rows: ElementStage[] = els.map((el) => {
    const percent: Record<string, number | null> = {};
    let planned = 0;
    let complete = 0;
    let last: { a: ActivityDef; full: boolean } | null = null;
    for (const a of acts) {
      const p = computeActivityProgress(el, a, entries);
      if (p.planned === null) {
        percent[a.code] = null;
        continue;
      }
      planned += 1;
      const done = p.approved + (mode === 'with-pending' ? p.pendingReview : 0);
      const full = done + QTY_EPSILON >= p.planned;
      percent[a.code] = roundQty(Math.min((done / p.planned) * 100, 100), 0);
      if (full) complete += 1;
      if (done > QTY_EPSILON) last = { a, full };
    }
    if (!planned) return { element: el, stage: 'no-plan', label: 'No planned quantity', percent };
    if (complete === planned) return { element: el, stage: 'complete', label: 'Complete', percent };
    if (!last) return { element: el, stage: 'not-started', label: 'Not started', percent };
    return last.full
      ? { element: el, stage: `${last.a.code}:done`, label: `${last.a.name} done`, percent }
      : { element: el, stage: `${last.a.code}:doing`, label: `${last.a.name} in progress`, percent };
  });

  // furthest first: complete, then the later activities, "in progress" after "done" of the same activity
  const rank = (s: string) => {
    if (s === 'complete') return -1;
    if (s === 'not-started') return 1e6;
    if (s === 'no-plan') return 1e6 + 1;
    const [code, kind] = s.split(':');
    const i = acts.findIndex((a) => a.code === code);
    return (acts.length - i) * 2 - (kind === 'done' ? 1 : 0);
  };
  const map = new Map<string, StageBucket>();
  for (const r of rows) {
    let b = map.get(r.stage);
    if (!b) map.set(r.stage, (b = { stage: r.stage, label: r.label, elements: [] }));
    b.elements.push(r.element);
  }
  return { activities: acts, rows, buckets: [...map.values()].sort((a, b) => rank(a.stage) - rank(b.stage)) };
}

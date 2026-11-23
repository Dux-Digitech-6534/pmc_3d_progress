import { activityApplies, type ActivityDef, type ElementRecord, type ElementType, type ProgressEntry, type Unit } from './types';

export type ActivityStatus = 'not-applicable' | 'not-configured' | 'not-started' | 'in-progress' | 'complete';

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  'not-applicable': 'Not applicable',
  'not-configured': 'Not configured',
  'not-started': 'Not started',
  'in-progress': 'In progress',
  complete: 'Complete',
};

/**
 * Revisions of the same model (same project and model ID) share their progress: an element that
 * is still in a new revision keeps the work approved on the earlier ones (matched by its stable
 * element ID). Work on elements a revision no longer has stays in the history but is not counted.
 */
export const inModelFamily = (e: Pick<ProgressEntry, 'projectId' | 'modelId'>, model: { projectId: string; modelId: string }) =>
  e.projectId === model.projectId && e.modelId === model.modelId;

/** Same as inModelFamily, for two model keys (project|model|revision). */
export const sameModelFamily = (keyA: string, keyB: string) => keyA.split('|').slice(0, 2).join('|') === keyB.split('|').slice(0, 2).join('|');

/** Quantities are compared with a small tolerance to absorb floating point noise. */
export const QTY_EPSILON = 1e-6;

export const roundQty = (n: number, decimals = 3) => {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
};

export interface ActivityProgress {
  activityCode: string;
  activityName: string;
  unit: Unit;
  /** null when planned quantity is missing or zero. */
  planned: number | null;
  approved: number;
  /** Submitted and awaiting PMC review — never counted as progress. */
  pendingReview: number;
  draft: number;
  remaining: number | null;
  /** approved / planned × 100, or null when not configured. */
  percent: number | null;
  status: ActivityStatus;
}

/**
 * Progress for one element + activity.
 *
 * Only APPROVED entries for the same element, activity and unit count. Drafts, submitted
 * and returned entries never change approved totals. Entries with a different unit are
 * ignored (they cannot be added to the planned unit).
 */
export function computeActivityProgress(
  element: Pick<ElementRecord, 'id' | 'plannedQuantities'> & { type?: ElementType },
  activity: ActivityDef,
  entries: ProgressEntry[],
): ActivityProgress {
  const applicable = !element.type || activityApplies(activity, element.type);
  const plannedDef = element.plannedQuantities[activity.code];
  const plannedOk =
    applicable &&
    plannedDef !== undefined &&
    Number.isFinite(plannedDef.quantity) &&
    plannedDef.quantity > 0 &&
    plannedDef.unit === activity.unit;

  let approved = 0;
  let pendingReview = 0;
  let draft = 0;
  for (const e of entries) {
    if (e.elementId !== element.id || e.activityCode !== activity.code) continue;
    if (e.unit !== activity.unit || !Number.isFinite(e.quantity) || e.quantity <= 0) continue;
    if (e.status === 'Approved') approved += e.quantity;
    else if (e.status === 'Submitted') pendingReview += e.quantity;
    else if (e.status === 'Draft') draft += e.quantity;
  }
  approved = roundQty(approved);
  pendingReview = roundQty(pendingReview);
  draft = roundQty(draft);

  if (!plannedOk) {
    return {
      activityCode: activity.code,
      activityName: activity.name,
      unit: activity.unit,
      planned: null,
      approved,
      pendingReview,
      draft,
      remaining: null,
      percent: null,
      status: applicable ? 'not-configured' : 'not-applicable',
    };
  }

  const planned = plannedDef.quantity;
  const percent = (approved / planned) * 100;
  const status: ActivityStatus =
    approved <= QTY_EPSILON ? 'not-started' : approved + QTY_EPSILON >= planned ? 'complete' : 'in-progress';

  return {
    activityCode: activity.code,
    activityName: activity.name,
    unit: activity.unit,
    planned,
    approved,
    pendingReview,
    draft,
    remaining: roundQty(Math.max(planned - approved, 0)),
    percent: roundQty(percent, 1),
    status,
  };
}

export interface ActivitySummary {
  activity: ActivityDef;
  /** Sum over configured elements only — every element shares this activity's single unit. */
  planned: number;
  approved: number;
  pendingReview: number;
  percent: number | null;
  counts: Record<ActivityStatus, number>;
}

/**
 * Project-level summary for ONE activity. Quantities are only ever summed within the
 * activity's own unit; different activities (kg, m², m³) are never combined.
 */
export function summarizeActivity(
  elements: ElementRecord[],
  activity: ActivityDef,
  entries: ProgressEntry[],
): ActivitySummary {
  const counts: Record<ActivityStatus, number> = {
    'not-applicable': 0,
    'not-configured': 0,
    'not-started': 0,
    'in-progress': 0,
    complete: 0,
  };
  let planned = 0;
  let approved = 0;
  let pendingReview = 0;
  for (const el of elements) {
    const p = computeActivityProgress(el, activity, entries);
    counts[p.status] += 1;
    if (p.planned !== null) {
      planned += p.planned;
      approved += p.approved;
      pendingReview += p.pendingReview;
    }
  }
  return {
    activity,
    planned: roundQty(planned),
    approved: roundQty(approved),
    pendingReview: roundQty(pendingReview),
    percent: planned > 0 ? roundQty((approved / planned) * 100, 1) : null,
    counts,
  };
}

export function formatQty(n: number | null | undefined, unit?: string) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const s = n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  return unit ? `${s} ${unit}` : s;
}

/**
 * Weightage of each work in the project progress % (meeting 21-11: "percentage from total quantity and
 * executed quantity"). Works are in different units (kg, m², m³), so each work's own % (approved ÷
 * planned) is weighted. Works not listed weigh 10.
 */
export const PROGRESS_WEIGHTS: Record<string, number> = { CONC: 40, REINF: 25, SHUT: 15, BRICK: 10, PLAST: 10 };
const DEFAULT_WEIGHT = 10;

export interface ProjectProgress {
  /** Project progress %, 0–100, one decimal; null when nothing is planned. */
  percent: number | null;
  /** Each work with planned quantity: its own %, its weight and its share of the total (weights scaled to 100). */
  parts: { code: string; name: string; percent: number; weight: number; share: number }[];
}

/** Project progress by quantity: the weighted average of each work's approved ÷ planned. */
export function projectProgress(summaries: Pick<ActivitySummary, 'activity' | 'percent'>[], weights: Record<string, number> = PROGRESS_WEIGHTS): ProjectProgress {
  const used = summaries.filter((s) => s.percent !== null);
  const total = used.reduce((a, s) => a + (weights[s.activity.code] ?? DEFAULT_WEIGHT), 0);
  if (!used.length || total <= 0) return { percent: null, parts: [] };
  const parts = used.map((s) => {
    const weight = weights[s.activity.code] ?? DEFAULT_WEIGHT;
    return { code: s.activity.code, name: s.activity.name, percent: Math.min(s.percent!, 100), weight, share: roundQty((weight / total) * 100, 1) };
  });
  const percent = roundQty(parts.reduce((a, p) => a + (p.percent * p.weight) / total, 0), 1);
  return { percent, parts };
}

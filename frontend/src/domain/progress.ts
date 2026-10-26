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

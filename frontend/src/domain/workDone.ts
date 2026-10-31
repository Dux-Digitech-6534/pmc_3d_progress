import { sumQty } from './allocation';
import { computeActivityProgress, roundQty, QTY_EPSILON } from './progress';
import { activityApplies, type ActivityDef, type ElementRecord, type ProgressEntry } from './types';

/**
 * "Work done" marking: the site says how far an activity has got on each ticked element (100% = done)
 * instead of typing quantities. The quantity recorded is the planned quantity × percent, less what is
 * already approved or waiting for approval — so marking 50% then 100% records the two halves.
 */
export interface WorkDoneRow {
  element: ElementRecord;
  /** Quantity this marking records for the element; 0 when skipped. */
  quantity: number;
  /** Why nothing is recorded for this element, if so. */
  skip?: 'not-applicable' | 'not-configured' | 'already-done';
}

export interface WorkDonePlan {
  activity: ActivityDef;
  rows: WorkDoneRow[];
  /** Rows that record something. */
  recording: WorkDoneRow[];
  total: number;
}

export function planWorkDone(elements: ElementRecord[], activity: ActivityDef, entries: ProgressEntry[], percent: number): WorkDonePlan {
  const pct = Math.min(Math.max(percent, 0), 100);
  const rows = elements.map((element): WorkDoneRow => {
    if (!activityApplies(activity, element.type)) return { element, quantity: 0, skip: 'not-applicable' };
    const p = computeActivityProgress(element, activity, entries);
    if (p.planned === null) return { element, quantity: 0, skip: 'not-configured' };
    const target = roundQty((p.planned * pct) / 100);
    const quantity = roundQty(Math.min(target, p.planned) - p.approved - p.pendingReview);
    return quantity > QTY_EPSILON ? { element, quantity } : { element, quantity: 0, skip: 'already-done' };
  });
  const recording = rows.filter((r) => !r.skip);
  return { activity, rows, recording, total: sumQty(recording.map((r) => r.quantity)) };
}

/** Percent of the planned quantity already approved or waiting for approval (null when not configured). */
export function markedPercent(element: ElementRecord, activity: ActivityDef, entries: ProgressEntry[]): number | null {
  const p = computeActivityProgress(element, activity, entries);
  if (p.planned === null || p.planned <= 0) return null;
  return Math.min(100, Math.round(((p.approved + p.pendingReview) / p.planned) * 100));
}

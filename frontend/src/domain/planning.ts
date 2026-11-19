import type { ActivityDef, ElementRecord, ProgressEntry } from './types';

/** One planned job: an activity on one element, for a date (meeting 16-11: plan first, then report what happened). */
export interface PlanItem {
  id: string;
  elementId: string;
  activityCode: string;
  /** First day of the plan, YYYY-MM-DD. */
  date: string;
  /** Last day of the plan (same as date, or absent, for a one-day plan). */
  to?: string;
  note?: string;
  createdBy?: string;
  createdAt?: string;
  /** Set when the planned job did not happen; the reason is required. */
  noWork?: { reason: string; by?: string; at?: string };
}

/** The date an activity was started on an element (Work Done "Started"). The complete date is the date of the entry that makes it 100 %. */
export interface StartMark {
  elementId: string;
  activityCode: string;
  date: string;
  by?: string;
  at?: string;
}

export interface PlanningData {
  plans: PlanItem[];
  starts: StartMark[];
}

export type PlanResult = 'done' | 'started' | 'no-work' | 'missed' | 'pending';

export const PLAN_RESULT_LABELS: Record<PlanResult, string> = {
  done: 'Done',
  started: 'Started',
  'no-work': 'No work',
  missed: 'Not reported',
  pending: 'Planned',
};

export interface PlanRow {
  plan: PlanItem;
  element?: ElementRecord;
  activity?: ActivityDef;
  result: PlanResult;
  /** Work reported for that element and activity on the plan date (sent or approved). */
  reported: number;
  /** "Done 2.4 m³", "Started", "No work: rain" … */
  detail: string;
}

/** Last day of a plan. */
export const planEnd = (p: Pick<PlanItem, 'date' | 'to'>) => (p.to && p.to > p.date ? p.to : p.date);

/**
 * Plan vs actual. A planned job (one element + activity, From..To) is
 *  - Done: work for it was reported (sent or approved) on a day From..To;
 *  - Started: it was marked started on a day From..To;
 *  - No work: the engineer said it did not happen, with the reason;
 *  - Not reported: the To date is over and none of the above — the engineer must report the work or "No work";
 *  - Planned: To is today or later, nothing yet.
 * A From / To filter keeps the plans that overlap those dates.
 */
export function planVsActual(
  data: PlanningData,
  entries: ProgressEntry[],
  elements: ElementRecord[],
  activities: ActivityDef[],
  today: string,
  from?: string,
  to?: string,
): PlanRow[] {
  const els = new Map(elements.map((e) => [e.id, e]));
  const acts = new Map(activities.map((a) => [a.code, a]));
  const reportedIn = (p: PlanItem) => {
    const end = planEnd(p);
    let q = 0;
    for (const e of entries)
      if ((e.status === 'Submitted' || e.status === 'Approved') && e.elementId === p.elementId && e.activityCode === p.activityCode && e.date >= p.date && e.date <= end) q += e.quantity;
    return q;
  };
  const startedIn = (p: PlanItem) => {
    const end = planEnd(p);
    return data.starts.some((s) => s.elementId === p.elementId && s.activityCode === p.activityCode && s.date >= p.date && s.date <= end);
  };
  return data.plans
    .filter((p) => (!from || planEnd(p) >= from) && (!to || p.date <= to))
    .map((p) => {
      const reported = reportedIn(p);
      const a = acts.get(p.activityCode);
      const unit = a ? ` ${a.unit === 'm3' ? 'm³' : a.unit === 'm2' ? 'm²' : a.unit}` : '';
      let result: PlanResult;
      let detail: string;
      if (reported > 0) {
        result = 'done';
        detail = `Done ${Math.round(reported * 1000) / 1000}${unit}`;
      } else if (startedIn(p)) {
        result = 'started';
        detail = 'Started';
      } else if (p.noWork) {
        result = 'no-work';
        detail = `No work: ${p.noWork.reason}`;
      } else if (planEnd(p) < today) {
        result = 'missed';
        detail = 'Nothing reported — report the work or "No work"';
      } else {
        result = 'pending';
        detail = p.date <= today ? 'Due now' : 'Planned';
      }
      return { plan: p, element: els.get(p.elementId), activity: a, result, reported, detail };
    })
    .sort((x, y) => (x.plan.date === y.plan.date ? (x.element?.code ?? '').localeCompare(y.element?.code ?? '') : x.plan.date.localeCompare(y.plan.date)));
}

export function countResults(rows: PlanRow[]): Record<PlanResult, number> {
  const out: Record<PlanResult, number> = { done: 0, started: 0, 'no-work': 0, missed: 0, pending: 0 };
  for (const r of rows) out[r.result] += 1;
  return out;
}

/** Start date of an activity on an element, if it was marked started. */
export const startOf = (data: PlanningData | null, elementId: string, activityCode: string) =>
  data?.starts.find((s) => s.elementId === elementId && s.activityCode === activityCode)?.date;

/** Date the activity reached 100 %: the date of the last entry (sent or approved) when the total covers the planned quantity. */
export function completeDateOf(el: Pick<ElementRecord, 'id' | 'plannedQuantities'>, activityCode: string, entries: ProgressEntry[]): string | undefined {
  const planned = el.plannedQuantities[activityCode]?.quantity;
  if (!planned) return undefined;
  const mine = entries
    .filter((e) => e.elementId === el.id && e.activityCode === activityCode && (e.status === 'Approved' || e.status === 'Submitted'))
    .sort((a, b) => a.date.localeCompare(b.date));
  let sum = 0;
  for (const e of mine) {
    sum += e.quantity;
    if (sum + 1e-6 >= planned) return e.date;
  }
  return undefined;
}

/** Whole days from start to complete, both counted (start 1st, complete 10th = 10 days). */
export function daysTaken(start?: string, complete?: string): number | undefined {
  if (!start || !complete) return undefined;
  const d = (Date.parse(`${complete}T00:00:00`) - Date.parse(`${start}T00:00:00`)) / 86400000;
  return d >= 0 ? Math.round(d) + 1 : undefined;
}

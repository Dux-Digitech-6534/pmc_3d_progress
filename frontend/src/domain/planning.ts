import type { ActivityDef, ElementRecord, ProgressEntry } from './types';

/** One planned job: an activity on one element, for a date (meeting 16-11: plan first, then report what happened). */
export interface PlanItem {
  id: string;
  elementId: string;
  activityCode: string;
  /** YYYY-MM-DD. */
  date: string;
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

/**
 * Plan vs actual. A planned job is
 *  - Done: work for that element + activity was reported (sent or approved) on the plan date;
 *  - Started: it was marked started on the plan date;
 *  - No work: the engineer said it did not happen, with the reason;
 *  - Not reported: the date is over and none of the above — the engineer must report the work or "No work";
 *  - Planned: today or later, nothing yet.
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
  const qty = new Map<string, number>();
  for (const e of entries) {
    if (e.status !== 'Submitted' && e.status !== 'Approved') continue;
    const k = `${e.elementId}|${e.activityCode}|${e.date}`;
    qty.set(k, (qty.get(k) ?? 0) + e.quantity);
  }
  const started = new Set(data.starts.map((s) => `${s.elementId}|${s.activityCode}|${s.date}`));
  return data.plans
    .filter((p) => (!from || p.date >= from) && (!to || p.date <= to))
    .map((p) => {
      const k = `${p.elementId}|${p.activityCode}|${p.date}`;
      const reported = qty.get(k) ?? 0;
      const a = acts.get(p.activityCode);
      const unit = a ? ` ${a.unit === 'm3' ? 'm³' : a.unit === 'm2' ? 'm²' : a.unit}` : '';
      let result: PlanResult;
      let detail: string;
      if (reported > 0) {
        result = 'done';
        detail = `Done ${Math.round(reported * 1000) / 1000}${unit}`;
      } else if (started.has(k)) {
        result = 'started';
        detail = 'Started';
      } else if (p.noWork) {
        result = 'no-work';
        detail = `No work: ${p.noWork.reason}`;
      } else if (p.date < today) {
        result = 'missed';
        detail = 'Nothing reported — report the work or "No work"';
      } else {
        result = 'pending';
        detail = p.date === today ? 'Planned for today' : 'Planned';
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

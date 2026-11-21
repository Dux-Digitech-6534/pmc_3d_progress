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
  /** Draft = can still be changed or removed; Submitted = final, plan vs actual is counted on it. Absent = Draft. */
  status?: 'draft' | 'submitted';
  submittedAt?: string;
  submittedBy?: string;
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

/** Activity code of a "No work" plan: nothing will be done on these elements in these dates (meeting 16-11). */
export const NO_WORK_CODE = 'NO-WORK';

export type PlanResult = 'done' | 'late' | 'started' | 'no-work' | 'missed' | 'pending';

export const PLAN_RESULT_LABELS: Record<PlanResult, string> = {
  done: 'Done on time',
  late: 'Late',
  started: 'Going on',
  'no-work': 'No work',
  missed: 'Not reported',
  pending: 'Planned',
};

export interface PlanRow {
  plan: PlanItem;
  element?: ElementRecord;
  activity?: ActivityDef;
  result: PlanResult;
  /** Work reported for that element and activity inside the plan dates (sent or approved). */
  reported: number;
  /** When the work really started: the Work Done "Started" date, else the first reported work. */
  actualStart?: string;
  /** When it reached 100 % (sent or approved). */
  actualDone?: string;
  /** Days after the planned To date (finished late, or still not finished). */
  lateDays?: number;
  /** "Finished 2 days late", "No work: rain" … */
  detail: string;
}

export const isSubmitted = (p: Pick<PlanItem, 'status'>) => p.status === 'submitted';
/** A planned job that is finished (on time or late). */
export const isCompleted = (r: Pick<PlanRow, 'actualDone'>) => !!r.actualDone;

/** Last day of a plan. */
export const planEnd = (p: Pick<PlanItem, 'date' | 'to'>) => (p.to && p.to > p.date ? p.to : p.date);

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86400000);

/**
 * Plan vs actual (meeting 16-11: "tera plan ye tha, aur ye hua"). For a planned job (one element + activity,
 * planned From..To) the actual start and complete dates come from Work Done:
 *  - Done on time: completed (100 %) on or before To;
 *  - Late: completed after To, or To is over and it is started but not finished;
 *  - Started: started, To not over yet;
 *  - No work: the engineer said it did not happen, with the reason;
 *  - Not reported: To is over and nothing was entered — report the work or "No work";
 *  - Planned: nothing yet, To not over.
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
  const counted = entries.filter((e) => e.status === 'Submitted' || e.status === 'Approved');
  return data.plans
    .filter((p) => (!from || planEnd(p) >= from) && (!to || p.date <= to))
    .map((p) => {
      const end = planEnd(p);
      const el = els.get(p.elementId);
      const a = acts.get(p.activityCode);
      if (p.activityCode === NO_WORK_CODE) {
        // planned that nothing will be done: it never needs a report
        const why = p.noWork?.reason || p.note;
        return { plan: p, element: el, activity: { code: NO_WORK_CODE, name: 'No work', unit: 'nos' } as ActivityDef, result: 'no-work' as PlanResult, reported: 0, detail: `No work planned${why ? `: ${why}` : ''}` };
      }
      const mine = counted.filter((e) => e.elementId === p.elementId && e.activityCode === p.activityCode);
      const reported = mine.filter((e) => e.date >= p.date && e.date <= end).reduce((n, e) => n + e.quantity, 0);
      const startMark = data.starts.find((s) => s.elementId === p.elementId && s.activityCode === p.activityCode)?.date;
      const firstWork = mine.map((e) => e.date).sort()[0];
      const actualStart = [startMark, firstWork].filter((d): d is string => !!d).sort()[0];
      const actualDone = el ? completeDateOf(el, p.activityCode, entries) : undefined;
      let result: PlanResult;
      let detail: string;
      let lateDays: number | undefined;
      if (actualDone) {
        lateDays = dayDiff(end, actualDone);
        if (lateDays > 0) {
          result = 'late';
          detail = `Finished ${lateDays} day${lateDays === 1 ? '' : 's'} late`;
        } else {
          result = 'done';
          lateDays = undefined;
          detail = 'Finished on time';
        }
      } else if (p.noWork) {
        result = 'no-work';
        detail = `No work: ${p.noWork.reason}`;
      } else if (end < today) {
        lateDays = dayDiff(end, today);
        if (actualStart) {
          result = 'late';
          detail = `Started, not finished — ${lateDays} day${lateDays === 1 ? '' : 's'} past the plan`;
        } else {
          result = 'missed';
          detail = 'Nothing entered — report the work or "No work"';
        }
      } else if (actualStart) {
        result = 'started';
        detail = 'Work going on';
      } else {
        result = 'pending';
        detail = p.date <= today ? 'Due now' : 'Still to come';
      }
      return { plan: p, element: el, activity: a, result, reported, actualStart, actualDone, lateDays, detail };
    })
    .sort((x, y) => (x.plan.date === y.plan.date ? (x.element?.code ?? '').localeCompare(y.element?.code ?? '') : x.plan.date.localeCompare(y.plan.date)));
}

export function countResults(rows: PlanRow[]): Record<PlanResult, number> {
  const out: Record<PlanResult, number> = { done: 0, late: 0, started: 0, 'no-work': 0, missed: 0, pending: 0 };
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

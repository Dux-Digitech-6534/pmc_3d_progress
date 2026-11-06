import { computeActivityProgress, QTY_EPSILON } from './progress';
import type { ActivityDef, ElementRecord, ProgressEntry } from './types';

/** Site order of the work on an element: steel and shuttering before the pour, walls before plaster, fixing last. */
const STAGES: RegExp[] = [/reinf|steel|bar\b|sariya/i, /shutter|formwork/i, /concret|pcc|rcc|pour/i, /brick|block|masonry/i, /plaster/i, /fix|door|window|frame/i];

export function stageOf(a: Pick<ActivityDef, 'code' | 'name'>): number {
  const text = `${a.code} ${a.name}`;
  const i = STAGES.findIndex((re) => re.test(text));
  return i < 0 ? STAGES.length : i;
}

/** Activities in site order (a stable sort: unknown activities keep their place at the end). */
export function inWorkOrder<T extends Pick<ActivityDef, 'code' | 'name'>>(acts: T[]): T[] {
  return acts
    .map((a, i) => ({ a, i, s: stageOf(a) }))
    .sort((x, y) => x.s - y.s || x.i - y.i)
    .map((x) => x.a);
}

export interface MissingPrior {
  element: ElementRecord;
  /** Earlier work on the element that is not yet reported in full (approved + waiting for approval). */
  activities: ActivityDef[];
}

/**
 * Elements where work that normally comes before `activity` is not yet reported in full
 * (e.g. concreting reported while the reinforcement is still open). Drafts and returned entries do not count.
 */
export function missingPriorWork(elements: ElementRecord[], activity: ActivityDef, activities: ActivityDef[], entries: ProgressEntry[]): MissingPrior[] {
  const stage = stageOf(activity);
  const earlier = activities.filter((a) => a.code !== activity.code && stageOf(a) < stage);
  if (!earlier.length) return [];
  const out: MissingPrior[] = [];
  for (const el of elements) {
    const open = earlier.filter((a) => {
      const p = computeActivityProgress(el, a, entries);
      if (p.planned === null || p.status === 'not-applicable') return false;
      return p.approved + p.pendingReview < p.planned - QTY_EPSILON;
    });
    if (open.length) out.push({ element: el, activities: open });
  }
  return out;
}

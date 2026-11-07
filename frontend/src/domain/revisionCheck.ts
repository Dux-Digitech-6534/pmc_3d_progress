import { formatQty, QTY_EPSILON, roundQty } from './progress';
import { UNIT_LABELS, type ElementRecord, type ModelDocument, type ProgressEntry } from './types';

/**
 * What a new revision takes away from work already reported on the current one (approved, waiting for
 * approval or in draft): elements that are no longer in the file, and planned quantities that drop
 * below what was reported. Plain sentences, one per element and activity.
 */
export function revisionConflicts(current: ElementRecord[], entries: ProgressEntry[], next: ModelDocument): string[] {
  const counted = entries.filter((e) => e.modelId === next.model.id && (e.status === 'Approved' || e.status === 'Submitted' || e.status === 'Draft'));
  if (!counted.length) return [];
  const nextById = new Map(next.elements.map((el) => [el.id, el]));
  const names = new Map(next.activities.map((a) => [a.code, a.name]));
  const codeOf = new Map(current.map((el) => [el.id, el.code]));
  // reported quantity per element and activity (same unit only)
  const reported = new Map<string, { elementId: string; code: string; name: string; unit: string; qty: number; n: number }>();
  for (const e of counted) {
    const k = `${e.elementId}|${e.activityCode}|${e.unit}`;
    const r = reported.get(k) ?? { elementId: e.elementId, code: e.activityCode, name: e.activityName, unit: e.unit, qty: 0, n: 0 };
    r.qty += e.quantity;
    r.n += 1;
    reported.set(k, r);
  }
  const out: string[] = [];
  const removed = new Map<string, string[]>();
  for (const r of reported.values()) {
    const el = nextById.get(r.elementId);
    const label = codeOf.get(r.elementId) ?? r.elementId;
    const unit = UNIT_LABELS[r.unit as keyof typeof UNIT_LABELS] ?? r.unit;
    if (!el) {
      removed.set(label, [...(removed.get(label) ?? []), r.name]);
      continue;
    }
    const plan = el.plannedQuantities[r.code];
    const planned = plan && plan.unit === r.unit ? plan.quantity : 0;
    const qty = roundQty(r.qty);
    if (qty > planned + QTY_EPSILON) {
      out.push(
        planned > 0
          ? `${label} ${names.get(r.code) ?? r.name}: ${formatQty(qty, unit)} already reported, the new plan is only ${formatQty(planned, unit)}.`
          : `${label} ${names.get(r.code) ?? r.name}: ${formatQty(qty, unit)} already reported, the new file has no ${names.get(r.code) ?? r.name} for it.`,
      );
    }
  }
  for (const [label, acts] of removed) out.unshift(`${label} is not in the new file — its reported work (${[...new Set(acts)].join(', ')}) stops counting.`);
  return out;
}

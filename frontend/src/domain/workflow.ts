import { roundQty, QTY_EPSILON } from './progress';
import { QTY_DECIMALS } from './allocation';
import { activityApplies, type ActivityDef, type ElementRecord, type ElementType, type EntryStatus, type ProgressEntry, type Role, type Unit } from './types';

/**
 * Workflow: Draft → Submitted → Approved | Returned; Returned → (edit) Draft → Submitted.
 *
 * The role switch in this prototype only demonstrates the workflow. It is NOT
 * authentication: anyone using the browser can pick any role. In ERPNext these checks
 * must be enforced on the server through roles, DocType permissions and a Workflow.
 */
export const permissions = {
  canCreate: (role: Role) => role === 'site-engineer',
  canEdit: (role: Role, e: Pick<ProgressEntry, 'status'>) =>
    role === 'site-engineer' && (e.status === 'Draft' || e.status === 'Returned'),
  canSubmit: (role: Role, e: Pick<ProgressEntry, 'status'>) => role === 'site-engineer' && e.status === 'Draft',
  canDelete: (role: Role, e: Pick<ProgressEntry, 'status'>) => role === 'site-engineer' && e.status === 'Draft',
  canReview: (role: Role, e: Pick<ProgressEntry, 'status'>) => role === 'pmc-reviewer' && e.status === 'Submitted',
};

export const STATUS_DESCRIPTIONS: Record<EntryStatus, string> = {
  Draft: 'Saved by the site engineer, not yet sent for review. Does not count as progress.',
  Submitted: 'Waiting for PMC review. Does not count as progress yet.',
  Approved: 'Approved by PMC. Counts towards owner-facing progress.',
  Returned: 'Returned by PMC for correction. Does not count as progress.',
};

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface QuantityCheckInput {
  element: Pick<ElementRecord, 'id' | 'code' | 'plannedQuantities'> & { type?: ElementType };
  activity: ActivityDef;
  quantity: number;
  unit: Unit | string;
  /** All entries for the project (filtered internally). */
  entries: ProgressEntry[];
  /** Entry being edited / reviewed — excluded from the "others" totals. */
  excludeEntryId?: string;
  /**
   * 'claim' (save/submit): approved + other submitted + this ≤ planned.
   * 'approve': approved + this ≤ planned.
   */
  mode: 'claim' | 'approve';
}

/** Returns human-readable validation errors for a quantity against an element's plan. */
export function checkQuantity(input: QuantityCheckInput): string[] {
  const { element, activity, quantity, unit, entries, excludeEntryId, mode } = input;
  const errors: string[] = [];
  const name = `${element.code} ${activity.name}`;

  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    errors.push('Completed quantity must be a number.');
    return errors;
  }
  if (quantity < 0) errors.push('Completed quantity cannot be negative.');
  else if (quantity === 0) errors.push('Completed quantity must be greater than zero.');
  else if (roundQty(quantity, QTY_DECIMALS) !== quantity) errors.push(`Use at most ${QTY_DECIMALS} decimals.`);

  if (element.type && !activityApplies(activity, element.type)) {
    errors.push(`${activity.name} does not apply to ${element.code} (${element.type}).`);
    return errors;
  }

  if (unit !== activity.unit) {
    errors.push(`Unit mismatch: ${activity.name} is measured in ${activity.unit}, not ${unit || '(blank)'}. Quantities in different units cannot be combined.`);
  }

  const planned = element.plannedQuantities[activity.code];
  if (!planned || !(planned.quantity > 0)) {
    errors.push(`Planned quantity for ${name} is not configured, so progress cannot be recorded against it. Update the model data first.`);
  } else if (planned.unit !== activity.unit) {
    errors.push(`Planned ${name} is in ${planned.unit} but the activity unit is ${activity.unit}. Fix the model data first.`);
  }
  if (errors.length) return errors;

  let approved = 0;
  let pending = 0;
  for (const e of entries) {
    if (e.id === excludeEntryId) continue;
    if (e.elementId !== element.id || e.activityCode !== activity.code || e.unit !== activity.unit) continue;
    if (e.status === 'Approved') approved += e.quantity;
    else if (e.status === 'Submitted') pending += e.quantity;
  }
  approved = roundQty(approved);
  pending = roundQty(pending);
  const committed = mode === 'claim' ? roundQty(approved + pending) : approved;
  const available = roundQty(planned!.quantity - committed);

  if (quantity > available + QTY_EPSILON) {
    const parts = [`planned ${planned!.quantity} ${activity.unit}`, `approved ${approved}`];
    if (mode === 'claim' && pending > 0) parts.push(`awaiting review ${pending}`);
    errors.push(
      `${quantity} ${activity.unit} exceeds the remaining quantity for ${name} (${parts.join(', ')}; available ${Math.max(available, 0)} ${activity.unit}). ` +
        'If the plan is wrong, revise the model quantities instead of over-reporting.',
    );
  }
  return errors;
}

/** Possible duplicate: same element, activity, date and quantity already recorded (and not returned). */
export function findPossibleDuplicate(
  entries: ProgressEntry[],
  candidate: Pick<ProgressEntry, 'elementId' | 'activityCode' | 'date' | 'quantity'> & { id?: string },
) {
  return entries.find(
    (e) =>
      e.id !== candidate.id &&
      e.status !== 'Returned' &&
      e.elementId === candidate.elementId &&
      e.activityCode === candidate.activityCode &&
      e.date === candidate.date &&
      Math.abs(e.quantity - candidate.quantity) < QTY_EPSILON,
  );
}

export function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function validateDate(date: string, today = todayISO()): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return ['Enter a valid date.'];
  if (date > today) return ['Date cannot be in the future.'];
  return [];
}

// How a project gets its concrete (meeting 21-11 follow-up): ready-mix (RMC, asked as grade + m³) or
// mixed on site (asked as cement, sand and gitti), and the grade of each RCC element type chosen in the
// app — so the grade does not depend on the BOQ Excel having a "concrete grade" column.

import { CONCRETE_GRADES, CONCRETE_MIXES, gradeName, RCC_ELEMENT_TYPES, type ConcreteNorm, type MaterialNorms, type RccType } from './materials';

export type ConcreteMode = 'rmc' | 'site';

export interface ConcreteSettings {
  mode: ConcreteMode;
  /** Grade per element type chosen in the app ("M25"); a type left out keeps the BOQ / planning grade. */
  gradeByType: Partial<Record<RccType, string>>;
}

export const DEFAULT_CONCRETE_SETTINGS: ConcreteSettings = { mode: 'rmc', gradeByType: {} };

export const CONCRETE_MODE_LABELS: Record<ConcreteMode, string> = { rmc: 'Ready-mix (RMC)', site: 'Mixed on site' };

/** Settings as read from storage, with anything unknown dropped. */
export function cleanConcreteSettings(raw: unknown): ConcreteSettings {
  const r = (raw ?? {}) as Partial<ConcreteSettings>;
  const gradeByType: Partial<Record<RccType, string>> = {};
  for (const t of RCC_ELEMENT_TYPES) {
    const g = r.gradeByType?.[t];
    if (typeof g === 'string' && (CONCRETE_GRADES as readonly string[]).includes(g)) gradeByType[t] = g;
  }
  return { mode: r.mode === 'site' ? 'site' : 'rmc', gradeByType };
}

/**
 * The grade of an element's concrete: the grade chosen in the app for its type, else the grade of the
 * element in the BOQ Excel, else the planning's grade for the type, else "Other".
 */
export function gradeOf(el: { type: string; concreteGrade?: string }, norms: MaterialNorms, settings: ConcreteSettings): string {
  const t = el.type as RccType;
  return settings.gradeByType[t] || el.concreteGrade?.trim() || (RCC_ELEMENT_TYPES.includes(t) ? norms.gradeByType[t] : '') || 'Other';
}

/** Cement, sand and gitti per m³ of concrete of a grade (site mix): the nominal mix of the grade, else the planning's mix. */
export function mixOf(grade: string, norms: MaterialNorms): ConcreteNorm {
  if (gradeName(norms.concreteGrade) === grade) return norms.concrete;
  const key = Object.keys(CONCRETE_MIXES).find((k) => gradeName(k) === grade);
  return key ? CONCRETE_MIXES[key] : norms.concrete;
}

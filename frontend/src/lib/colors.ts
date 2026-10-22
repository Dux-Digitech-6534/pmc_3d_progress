import type { ActivityStatus } from '../domain/progress';
import type { ElementType } from '../domain/types';

export const STATUS_COLORS: Record<ActivityStatus, string> = {
  'not-started': '#9aa3ad',
  'in-progress': '#f59e0b',
  complete: '#16a34a',
  'not-configured': '#d9cdf5',
  'not-applicable': '#f1f3f5',
};

export const TYPE_COLORS: Record<ElementType, string> = {
  footing: '#a47551',
  column: '#5b7290',
  beam: '#5f9e8f',
  slab: '#b9c2cc',
  wall: '#d8c3a5',
  lintel: '#6f8f86',
  chhajja: '#8aa4b5',
  door: '#8b5a2b',
  window: '#7cc4e8',
};

export const TYPE_LABELS: Record<ElementType, string> = {
  footing: 'Footing',
  column: 'Column',
  beam: 'Beam',
  slab: 'Slab',
  wall: 'Wall',
  lintel: 'Lintel',
  chhajja: 'Chhajja',
  door: 'Door',
  window: 'Window',
};

export const SELECTION_COLOR = '#2563eb';

/** Submitted work waiting for PMC approval (shown to engineer / reviewer, never counted as progress). */
export const AWAITING_COLOR = '#7cb5f5';

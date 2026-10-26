// Core domain types. These are deliberately independent of React, Three.js and storage
// so the same shapes can later be served by a Frappe/ERPNext backend.

export const ELEMENT_TYPES = ['footing', 'column', 'beam', 'slab', 'wall', 'lintel', 'chhajja', 'door', 'window'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const SUPPORTED_UNITS = ['kg', 'm2', 'm3', 'm', 'nos'] as const;
export type Unit = (typeof SUPPORTED_UNITS)[number];

export const UNIT_LABELS: Record<Unit, string> = {
  kg: 'kg',
  m2: 'm²',
  m3: 'm³',
  m: 'm',
  nos: 'nos',
};

export type Vec3 = [number, number, number];

export interface BoxGeometry {
  shape: 'box';
  /** Centre of the box in metres, Y axis up, ground level at y = 0. */
  position: Vec3;
  /** Width (X), height (Y), depth (Z) in metres. */
  size: Vec3;
}

/** A rectangular hole in a wall (door / window / ventilator), in the wall's own coordinates. */
export interface WallOpening {
  /** Offset of the opening centre from the wall centre, along the wall length, metres. */
  center: number;
  /** Height of the opening bottom above the wall bottom (sill height), metres. */
  bottom: number;
  width: number;
  height: number;
}

/**
 * An axis-aligned wall: like a box, but with rectangular openings cut through its thickness.
 * The wall runs along X when size[0] >= size[2], otherwise along Z.
 */
export interface WallGeometry {
  shape: 'wall';
  position: Vec3;
  size: Vec3;
  openings?: WallOpening[];
}

export type ElementGeometry = BoxGeometry | WallGeometry;

/** Length, height and thickness of a wall, whichever horizontal axis it runs along. */
export function wallDims(g: Pick<WallGeometry, 'size'>) {
  const alongX = g.size[0] >= g.size[2];
  return { alongX, length: alongX ? g.size[0] : g.size[2], height: g.size[1], thickness: alongX ? g.size[2] : g.size[0] };
}

export interface PlannedQuantity {
  quantity: number;
  unit: Unit;
}

export interface ActivityDef {
  code: string;
  name: string;
  unit: Unit;
  /** Element types this activity applies to. Absent = all types. Others show "Not applicable". */
  appliesTo?: ElementType[];
}

export const activityApplies = (a: Pick<ActivityDef, 'appliesTo'>, type: ElementType) => !a.appliesTo || a.appliesTo.includes(type);

export interface BuildingDef {
  id: string;
  name: string;
}

export interface LevelDef {
  id: string;
  name: string;
  buildingId: string;
  elevation?: number;
}

/** One selectable element exactly as it appears in the model file. */
export interface ModelElementDef {
  /** Stable source element ID, unique inside the model. Never a display name or Three.js object id. */
  id: string;
  /** Human-readable display code such as C-01. Not a unique key. */
  code: string;
  type: ElementType;
  buildingId: string;
  levelId: string;
  geometry: ElementGeometry;
  /** Keyed by activity code. A missing key or a zero quantity means "Not configured". */
  plannedQuantities: Record<string, PlannedQuantity>;
  notes?: string;
}

/** The documented JSON import format (see docs/MODEL_FORMAT.md). */
export interface ModelDocument {
  format: 'pmc-procedural-model';
  formatVersion: 1;
  project: { id: string; name: string; location?: string; client?: string };
  model: {
    id: string;
    name: string;
    revision: string;
    lengthUnit: 'm';
    upAxis?: 'y';
    source?: Record<string, unknown>;
  };
  buildings: BuildingDef[];
  levels: LevelDef[];
  activities: ActivityDef[];
  elements: ModelElementDef[];
}

export interface Project {
  id: string;
  name: string;
  location?: string;
  client?: string;
  /** Key of the model revision that currently drives the viewer, or null if no model imported yet. */
  activeModelKey: string | null;
  createdAt: string;
}

export type ModelSourceType = 'Bundled sample (procedural JSON)' | 'Uploaded JSON file' | 'Model Builder (from drawing)';
/**
 * Active = shown in 3D and used for progress. Pending Approval = planning submitted by a site
 * engineer, waiting for the PMC reviewer; Returned = sent back with remarks. Neither is used for
 * progress, and both may be replaced by a corrected submission of the same revision.
 */
export type ModelImportStatus = 'Active' | 'Superseded' | 'Failed' | 'Pending Approval' | 'Returned';

/** Statuses of a model that is still being planned (not approved yet). */
export const PLANNING_STATUSES: readonly ModelImportStatus[] = ['Pending Approval', 'Returned'];

export interface ModelRecord {
  /** projectId|modelId|revision — the permanent mapping key for elements and progress. */
  key: string;
  projectId: string;
  modelId: string;
  name: string;
  revision: string;
  sourceType: ModelSourceType;
  sourceName: string;
  importedAt: string;
  status: ModelImportStatus;
  elementCount: number;
  warnings: string[];
  /** Only present for failed imports. */
  errors?: string[];
  /** The validated document. Absent for failed imports. */
  document?: ModelDocument;
  /** PMC review of a submitted planning: remarks (required when returned), who and when. */
  reviewRemarks?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** An element resolved in the context of a project + model revision. */
export interface ElementRecord extends ModelElementDef {
  /** projectId|modelId|revision|sourceElementId — unique across the whole application. */
  key: string;
  projectId: string;
  modelKey: string;
  modelId: string;
  modelRevision: string;
  buildingName: string;
  levelName: string;
}

export type Role = 'site-engineer' | 'pmc-reviewer' | 'owner';

export const ROLE_LABELS: Record<Role, string> = {
  'site-engineer': 'Site Engineer',
  'pmc-reviewer': 'PMC Reviewer',
  owner: 'Owner',
};

export type EntryStatus = 'Draft' | 'Submitted' | 'Approved' | 'Returned';
export const ENTRY_STATUSES: EntryStatus[] = ['Draft', 'Submitted', 'Approved', 'Returned'];

export interface PhotoMeta {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface HistoryItem {
  at: string;
  role: Role;
  action: 'Created' | 'Edited' | 'Submitted' | 'Approved' | 'Returned';
  note?: string;
}

export type AllocationMode = 'single' | 'per-element' | 'total-manual' | 'total-equal';

export interface BatchInfo {
  id: string;
  mode: Exclude<AllocationMode, 'single'>;
  elementCount: number;
  /** Entered total across the selection (only for total-* modes). */
  total?: number;
  /** Quantity entered per element (only for per-element mode). */
  perElement?: number;
}

export interface ProgressEntry {
  id: string;
  /** Idempotency key generated by the client for each save action — retries return the same record. */
  clientRequestId: string;
  projectId: string;
  modelKey: string;
  modelId: string;
  modelRevision: string;
  elementId: string;
  elementCode: string;
  elementType: ElementType;
  activityCode: string;
  activityName: string;
  /** YYYY-MM-DD (site date). */
  date: string;
  quantity: number;
  unit: Unit;
  remarks: string;
  status: EntryStatus;
  photos: PhotoMeta[];
  batch?: BatchInfo;
  reviewRemarks?: string;
  createdAt: string;
  updatedAt: string;
  history: HistoryItem[];
}

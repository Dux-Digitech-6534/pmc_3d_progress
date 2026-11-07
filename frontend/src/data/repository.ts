import type { ReviewDecision } from '../domain/workflow';
import type { QuantityMode } from '../domain/allocation';
import type { ItemMatch, SentLine } from '../domain/materialVariation';
import type {
  ElementRecord,
  ModelRecord,
  ModelSourceType,
  PhotoMeta,
  ProgressEntry,
  Project,
  Role,
} from '../domain/types';

/**
 * Data-access contract used by the UI. The UI never touches localStorage, IndexedDB or
 * (later) HTTP directly — it only talks to this interface.
 *
 * Today: LocalRepository (browser localStorage).
 * Later: a FrappeRepository that calls whitelisted server methods on ERPNext.
 * See docs/ERPNEXT_INTEGRATION.md.
 */
export interface PmcRepository {
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project | null>;

  listModels(projectId?: string): Promise<ModelRecord[]>;
  /** The active model revision for a project, or null when none has been imported. */
  getProjectModel(projectId: string): Promise<ModelRecord | null>;
  /** Elements of the project's active model revision. */
  listElements(projectId: string): Promise<ElementRecord[]>;
  importModel(input: ImportModelInput): Promise<ImportModelOutcome>;
  setActiveModel(modelKey: string): Promise<void>;
  /** PMC reviewer: approve a submitted planning (it becomes the Active model) or return it with remarks. */
  reviewModel(modelKey: string, decision: 'approve' | 'return', remarks: string, role: Role): Promise<void>;

  /** Entries for a project. By default all revisions; pass modelKey to scope to one revision. */
  listProgressEntries(projectId: string, opts?: { modelKey?: string }): Promise<ProgressEntry[]>;
  listAllProgressEntries(): Promise<ProgressEntry[]>;
  saveProgressEntry(input: SaveEntryInput, role: Role): Promise<ProgressEntry>;
  saveBatchEntries(input: SaveBatchInput, role: Role): Promise<ProgressEntry[]>;
  submitProgressEntry(entryId: string, role: Role): Promise<ProgressEntry>;
  reviewProgressEntry(entryId: string, decision: ReviewDecision, remarks: string, role: Role): Promise<ProgressEntry>;
  deleteDraftEntry(entryId: string, role: Role): Promise<void>;

  resetDemoData(): Promise<void>;

  /** ERPNext projects, to pick the one whose material movements belong to a PMC project. */
  listErpProjects(): Promise<ErpProject[]>;
  /**
   * Material sent to an ERPNext project: item lines of submitted Stock Entries (Material Issue /
   * Material Transfer) and Purchase Receipts that carry the project, in the item's stock unit.
   */
  listMaterialSent(erpProjectId: string, fromDate?: string, toDate?: string): Promise<SentLine[]>;
  /** Enabled ERPNext items (code, name, stock unit), to put on a Material Request. */
  listErpItems(): Promise<ErpItem[]>;
  listErpCompanies(): Promise<string[]>;
  /** Leaf warehouses of a company. */
  listErpWarehouses(company: string): Promise<string[]>;
  /** Create an ERPNext Material Request (Purchase); it starts in the ERP's approval workflow. */
  createMaterialRequest(input: MaterialRequestInput): Promise<{ name: string; state: string }>;
  /** Send a saved (draft) Material Request on: its ERPNext workflow's first step, or a plain submit without a workflow. */
  submitMaterialRequest(name: string): Promise<{ name: string; state: string }>;
  /** Material variation settings kept for everyone: the ERPNext project of a PMC project, and items set by hand. */
  getVariationSettings(projectId: string): Promise<VariationSettings>;
  saveVariationSettings(projectId: string, change: { erpProject?: string; itemMap?: ItemMap }): Promise<VariationSettings>;
  /** The ERPNext project of a PMC project — linked before, found by the same name, or created — so nobody has to pick it. */
  ensureErpProject(projectId: string): Promise<{ erpProject: string; erpProjectName: string }>;
}

/** ERP item code → what material it is (set by hand), or 'ignore' = not a building material. */
export type ItemMap = Record<string, ItemMatch | 'ignore'>;

export interface VariationSettings {
  erpProject: string;
  itemMap: ItemMap;
}

export interface ErpProject {
  id: string;
  name: string;
}

export interface ErpItem {
  code: string;
  name: string;
  uom: string;
}

export interface MaterialRequestInput {
  company: string;
  /** ERPNext project of every line. */
  project?: string;
  warehouse?: string;
  /** YYYY-MM-DD. */
  requiredBy: string;
  lines: { itemCode: string; qty: number; uom: string }[];
}

export interface ImportModelInput {
  /** Raw JSON text, exactly as read from the file. */
  text: string;
  sourceName: string;
  sourceType: ModelSourceType;
  /** If given, the file's project.id must match. If omitted, the project is created when missing. */
  targetProjectId?: string;
  /**
   * Who creates it. A PMC reviewer's model is active at once; anyone else's waits for PMC approval
   * ("Pending Approval"). Omitted (JSON import, samples): active at once, as before.
   */
  role?: Role;
}

export interface ImportModelOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
  record?: ModelRecord;
  createdProject?: boolean;
  supersededKey?: string;
}

export interface SaveEntryInput {
  /** Set when editing an existing Draft/Returned entry. */
  id?: string;
  /** Unique per user action; a retry with the same id returns the already-saved record. */
  clientRequestId: string;
  projectId: string;
  elementId: string;
  activityCode: string;
  date: string;
  quantity: number;
  unit: string;
  remarks: string;
  photos: PhotoMeta[];
  /** Also submit for review in the same action. */
  submit?: boolean;
  /** User confirmed that an identical-looking entry is genuinely separate work. */
  confirmDuplicate?: boolean;
}

export interface SaveBatchInput {
  clientRequestId: string;
  projectId: string;
  elementIds: string[];
  activityCode: string;
  date: string;
  unit: string;
  remarks: string;
  photos: PhotoMeta[];
  /** 'total' = value is the total across the selection; 'per-element' = value applies to each element. */
  mode: QuantityMode;
  value: number;
  /** Required for mode 'total'. */
  allocationMethod?: 'manual' | 'equal';
  allocations?: Record<string, number>;
  submit?: boolean;
  confirmDuplicate?: boolean;
}

export type RepositoryErrorCode = 'validation' | 'possible-duplicate' | 'conflict' | 'not-found' | 'forbidden' | 'storage';

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly details: string[];
  constructor(code: RepositoryErrorCode, details: string[] | string) {
    const list = Array.isArray(details) ? details : [details];
    super(list.join(' '));
    this.name = 'RepositoryError';
    this.code = code;
    this.details = list;
  }
}

export function errorMessages(e: unknown): string[] {
  if (e instanceof RepositoryError) return e.details;
  if (e instanceof Error) return [e.message];
  return [String(e)];
}

import { resolveBatchQuantities } from '../domain/allocation';
import { validateModelDocument } from '../domain/modelValidation';
import type { ActivityDef, ElementRecord, HistoryItem, ModelRecord, ProgressEntry, Project, Role, Unit } from '../domain/types';
import { PLANNING_STATUSES, ROLE_LABELS } from '../domain/types';
import { inModelFamily } from '../domain/progress';
import { checkQuantity, findPossibleDuplicate, permissions, validateDate } from '../domain/workflow';
import { elementsFromModel, modelKeyOf } from './elements';
import {
  RepositoryError,
  type ImportModelInput,
  type ImportModelOutcome,
  type PmcRepository,
  type SaveBatchInput,
  type SaveEntryInput,
} from './repository';

/** Every key this application writes starts with this prefix; reset only removes these. */
export const STORAGE_PREFIX = 'pmc3d.v1.';
const K = {
  meta: `${STORAGE_PREFIX}meta`,
  projects: `${STORAGE_PREFIX}projects`,
  models: `${STORAGE_PREFIX}models`,
  entries: `${STORAGE_PREFIX}entries`,
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

interface Meta {
  seq: number;
  seededAt: string | null;
  /** clientRequestId → ids of entries produced by that request (idempotency). */
  processedRequests: Record<string, string[]>;
}

export interface LocalRepositoryOptions {
  storage: StorageLike;
  /** Artificial delay to mimic a network round-trip so loading states are exercised. */
  latencyMs?: number;
  now?: () => Date;
  /** Called once when storage is empty (and after reset) to load demo data. */
  seed?: (repo: LocalRepository) => Promise<void>;
  onReset?: () => Promise<void>;
}

export class LocalRepository implements PmcRepository {
  private readonly storage: StorageLike;
  private readonly latencyMs: number;
  private readonly now: () => Date;
  private readonly seedFn?: (repo: LocalRepository) => Promise<void>;
  private readonly onReset?: () => Promise<void>;
  private ready: Promise<void> | null = null;

  constructor(opts: LocalRepositoryOptions) {
    this.storage = opts.storage;
    this.latencyMs = opts.latencyMs ?? 0;
    this.now = opts.now ?? (() => new Date());
    this.seedFn = opts.seed;
    this.onReset = opts.onReset;
  }

  // ---------- infrastructure ----------

  private read<T>(key: string, fallback: T): T {
    const raw = this.storage.getItem(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new RepositoryError('storage', `Stored data under "${key}" is corrupted. Use "Reset Demo Data" to start again.`);
    }
  }

  private write(key: string, value: unknown) {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch (e) {
      throw new RepositoryError('storage', `Could not save to browser storage (${(e as Error).message}). Nothing was saved.`);
    }
  }

  private meta(): Meta {
    return this.read<Meta>(K.meta, { seq: 0, seededAt: null, processedRequests: {} });
  }

  private async init() {
    if (!this.ready) {
      this.ready = (async () => {
        if (this.meta().seededAt === null && this.seedFn) {
          // Seed through a separate instance (same storage, no seed, no latency) so that UI
          // calls made meanwhile keep waiting on this.ready instead of seeing partial data.
          await this.seedFn(new LocalRepository({ storage: this.storage, now: this.now }));
          const m = this.meta();
          this.write(K.meta, { ...m, seededAt: this.nowIso() });
        }
      })();
    }
    await this.ready;
  }

  private async op<T>(fn: () => T): Promise<T> {
    await this.init();
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    return fn();
  }

  private nowIso() {
    return this.now().toISOString();
  }

  private nextId(prefix: string) {
    const m = this.meta();
    m.seq += 1;
    this.write(K.meta, m);
    return `${prefix}-${String(m.seq).padStart(5, '0')}`;
  }

  private projects(): Project[] {
    return this.read<Project[]>(K.projects, []);
  }
  private models(): ModelRecord[] {
    return this.read<ModelRecord[]>(K.models, []);
  }
  private entries(): ProgressEntry[] {
    return this.read<ProgressEntry[]>(K.entries, []);
  }

  private activeContext(projectId: string) {
    const project = this.projects().find((p) => p.id === projectId);
    if (!project) throw new RepositoryError('not-found', `Project ${projectId} was not found.`);
    const model = this.models().find((m) => m.key === project.activeModelKey);
    if (!model?.document) throw new RepositoryError('validation', `Project ${project.name} has no imported model yet.`);
    return { project, model, elements: elementsFromModel(model), activities: model.document.activities };
  }

  // ---------- projects & models ----------

  listProjects() {
    return this.op(() => this.projects());
  }

  getProject(projectId: string) {
    return this.op(() => this.projects().find((p) => p.id === projectId) ?? null);
  }

  /** Used by the seed to register a project that has no model yet. */
  async createProject(p: Omit<Project, 'createdAt' | 'activeModelKey'>) {
    return this.op(() => {
      const list = this.projects();
      if (list.some((x) => x.id === p.id)) throw new RepositoryError('conflict', `Project ${p.id} already exists.`);
      const project: Project = { ...p, activeModelKey: null, createdAt: this.nowIso() };
      this.write(K.projects, [...list, project]);
      return project;
    });
  }

  listModels(projectId?: string) {
    return this.op(() => {
      const list = this.models();
      return projectId ? list.filter((m) => m.projectId === projectId) : list;
    });
  }

  getProjectModel(projectId: string) {
    return this.op(() => {
      const project = this.projects().find((p) => p.id === projectId);
      if (!project?.activeModelKey) return null;
      return this.models().find((m) => m.key === project.activeModelKey) ?? null;
    });
  }

  listElements(projectId: string) {
    return this.op(() => {
      const project = this.projects().find((p) => p.id === projectId);
      const model = this.models().find((m) => m.key === project?.activeModelKey);
      return model ? elementsFromModel(model) : [];
    });
  }

  importModel(input: ImportModelInput): Promise<ImportModelOutcome> {
    return this.op(() => {
      let parsed: unknown;
      const failed = (errors: string[], warnings: string[] = [], projectId = input.targetProjectId ?? '(unknown)'): ImportModelOutcome => {
        // Failed attempts are kept in the register so the import status is auditable.
        const record: ModelRecord = {
          key: `failed|${this.nextId('IMP')}`,
          projectId,
          modelId: '—',
          name: input.sourceName,
          revision: '—',
          sourceType: input.sourceType,
          sourceName: input.sourceName,
          importedAt: this.nowIso(),
          status: 'Failed',
          elementCount: 0,
          warnings,
          errors,
        };
        this.write(K.models, [...this.models(), record]);
        return { ok: false, errors, warnings, record };
      };

      try {
        parsed = JSON.parse(input.text);
      } catch (e) {
        return failed([`File is not valid JSON: ${(e as Error).message}`]);
      }
      const v = validateModelDocument(parsed);
      if (!v.ok || !v.document) {
        const fileProjectId = (parsed as { project?: { id?: unknown } } | null)?.project?.id;
        return failed(v.errors, v.warnings, input.targetProjectId ?? (typeof fileProjectId === 'string' ? fileProjectId : undefined));
      }
      const doc = v.document;

      if (input.targetProjectId && doc.project.id !== input.targetProjectId) {
        return failed(
          [`This model belongs to project "${doc.project.id}" but you are importing into "${input.targetProjectId}". Choose the matching project, or import with "Use project from file".`],
          v.warnings,
        );
      }

      const key = modelKeyOf(doc.project.id, doc.model.id, doc.model.revision);
      // a submission still waiting for (or returned by) the PMC may be replaced by a corrected one
      let models = this.models();
      const waiting = models.find((m) => m.key === key && PLANNING_STATUSES.includes(m.status));
      if (waiting) models = models.filter((m) => m !== waiting);
      const pending = input.role !== undefined && input.role !== 'pmc-reviewer';
      if (models.some((m) => m.key === key)) {
        return failed(
          [`Model ${doc.model.id} revision ${doc.model.revision} is already imported for ${doc.project.id}. A changed model must use a new revision (e.g. R02); existing revisions are never overwritten.`],
          v.warnings,
          doc.project.id,
        );
      }

      let projects = this.projects();
      let createdProject = false;
      if (!projects.some((p) => p.id === doc.project.id)) {
        projects = [
          ...projects,
          {
            id: doc.project.id,
            name: doc.project.name,
            location: doc.project.location,
            client: doc.project.client,
            activeModelKey: null,
            createdAt: this.nowIso(),
          },
        ];
        createdProject = true;
      }
      const project = projects.find((p) => p.id === doc.project.id)!;
      const supersededKey = project.activeModelKey ?? undefined;

      const record: ModelRecord = {
        key,
        projectId: doc.project.id,
        modelId: doc.model.id,
        name: doc.model.name,
        revision: doc.model.revision,
        sourceType: input.sourceType,
        sourceName: input.sourceName,
        importedAt: this.nowIso(),
        status: pending ? 'Pending Approval' : 'Active',
        elementCount: doc.elements.length,
        warnings: v.warnings,
        document: doc,
      };

      if (pending) {
        // waits for the PMC: the project keeps its current model
        this.write(K.models, [...models, record]);
        this.write(K.projects, projects);
        return { ok: true, errors: [], warnings: v.warnings, record, createdProject };
      }
      const nextModels = models.map((m) =>
        m.projectId === doc.project.id && m.status === 'Active' ? { ...m, status: 'Superseded' as const } : m,
      );
      this.write(K.models, [...nextModels, record]);
      this.write(
        K.projects,
        projects.map((p) => (p.id === doc.project.id ? { ...p, activeModelKey: key } : p)),
      );
      return { ok: true, errors: [], warnings: v.warnings, record, createdProject, supersededKey };
    });
  }

  reviewModel(modelKey: string, decision: 'approve' | 'return', remarks: string, role: Role) {
    return this.op(() => {
      if (role !== 'pmc-reviewer') throw new RepositoryError('forbidden', 'Only the PMC Reviewer can approve or return a planning.');
      const models = this.models();
      const target = models.find((m) => m.key === modelKey);
      if (!target || target.status !== 'Pending Approval') {
        throw new RepositoryError('conflict', 'This planning is not waiting for approval (it may have been reviewed or replaced). Refresh the list.');
      }
      const note = remarks.trim();
      if (decision === 'return' && !note) throw new RepositoryError('validation', 'Write what has to be corrected when returning a planning.');
      const reviewed = { reviewRemarks: note || undefined, reviewedBy: 'PMC Reviewer', reviewedAt: this.nowIso() };
      if (decision === 'return') {
        this.write(K.models, models.map((m) => (m.key === modelKey ? { ...m, ...reviewed, status: 'Returned' as const } : m)));
        return;
      }
      this.write(
        K.models,
        models.map((m) =>
          m.projectId !== target.projectId || m.status === 'Failed' || (PLANNING_STATUSES.includes(m.status) && m.key !== modelKey)
            ? m
            : m.key === modelKey
              ? { ...m, ...reviewed, status: 'Active' as const }
              : { ...m, status: 'Superseded' as const },
        ),
      );
      this.write(K.projects, this.projects().map((p) => (p.id === target.projectId ? { ...p, activeModelKey: modelKey } : p)));
    });
  }

  setActiveModel(modelKey: string) {
    return this.op(() => {
      const models = this.models();
      const target = models.find((m) => m.key === modelKey);
      if (!target || target.status === 'Failed' || !target.document) {
        throw new RepositoryError('not-found', 'That model revision cannot be activated.');
      }
      if (PLANNING_STATUSES.includes(target.status)) {
        throw new RepositoryError('forbidden', 'This planning is not approved yet — the PMC Reviewer approves it in the Model Register.');
      }
      this.write(
        K.models,
        models.map((m) =>
          m.projectId !== target.projectId || m.status === 'Failed' || PLANNING_STATUSES.includes(m.status)
            ? m
            : { ...m, status: m.key === modelKey ? ('Active' as const) : ('Superseded' as const) },
        ),
      );
      this.write(
        K.projects,
        this.projects().map((p) => (p.id === target.projectId ? { ...p, activeModelKey: modelKey } : p)),
      );
    });
  }

  // ---------- progress entries ----------

  listProgressEntries(projectId: string, opts?: { modelKey?: string }) {
    return this.op(() =>
      this.entries().filter((e) => e.projectId === projectId && (!opts?.modelKey || e.modelKey === opts.modelKey)),
    );
  }

  listAllProgressEntries() {
    return this.op(() => this.entries());
  }

  private replayed(clientRequestId: string): ProgressEntry[] | null {
    const ids = this.meta().processedRequests[clientRequestId];
    if (!ids) return null;
    const all = this.entries();
    return ids.map((id) => all.find((e) => e.id === id)).filter((e): e is ProgressEntry => !!e);
  }

  private remember(clientRequestId: string, ids: string[]) {
    const m = this.meta();
    m.processedRequests[clientRequestId] = ids;
    this.write(K.meta, m);
  }

  private hist(role: Role, action: HistoryItem['action'], note?: string): HistoryItem {
    return { at: this.nowIso(), role, action, ...(note ? { note } : {}) };
  }

  private findActivity(activities: ActivityDef[], code: string) {
    const a = activities.find((x) => x.code === code);
    if (!a) throw new RepositoryError('validation', `Unknown activity "${code}" for this model.`);
    return a;
  }

  private findElement(elements: ElementRecord[], id: string) {
    const el = elements.find((e) => e.id === id);
    if (!el) throw new RepositoryError('validation', `Element "${id}" is not part of the active model revision.`);
    return el;
  }

  saveProgressEntry(input: SaveEntryInput, role: Role) {
    return this.op(() => {
      const replay = this.replayed(input.clientRequestId);
      if (replay?.length) return replay[0];

      if (!permissions.canCreate(role)) {
        throw new RepositoryError('forbidden', `${ROLE_LABELS[role]} cannot create or edit progress entries (demo role rules).`);
      }
      const { model, elements, activities } = this.activeContext(input.projectId);
      const element = this.findElement(elements, input.elementId);
      const activity = this.findActivity(activities, input.activityCode);
      const all = this.entries();

      let existing: ProgressEntry | undefined;
      if (input.id) {
        existing = all.find((e) => e.id === input.id);
        if (!existing) throw new RepositoryError('not-found', `Entry ${input.id} no longer exists.`);
        if (!permissions.canEdit(role, existing)) {
          throw new RepositoryError('conflict', `Entry ${existing.id} is ${existing.status} and can no longer be edited.`);
        }
        if (!inModelFamily(existing, model)) {
          throw new RepositoryError('conflict', `Entry ${existing.id} belongs to model ${existing.modelId} ${existing.modelRevision}, which is not the active model.`);
        }
      }

      const remarks = input.remarks.trim();
      const errors = [
        ...validateDate(input.date, isoDate(this.now())),
        ...checkQuantity({
          element,
          activity,
          quantity: input.quantity,
          unit: input.unit,
          entries: all.filter((e) => inModelFamily(e, model)),
          excludeEntryId: input.id,
          mode: 'claim',
        }),
        ...(remarks.length > 500 ? ['Remarks must be 500 characters or fewer.'] : []),
      ];
      if (errors.length) throw new RepositoryError('validation', errors);

      if (!input.confirmDuplicate) {
        const dup = findPossibleDuplicate(
          all.filter((e) => inModelFamily(e, model)),
          { id: input.id, elementId: element.id, activityCode: activity.code, date: input.date, quantity: input.quantity },
        );
        if (dup) {
          throw new RepositoryError(
            'possible-duplicate',
            `An entry with the same element, activity, date and quantity already exists (${dup.id}, ${dup.status}). Confirm it is separate work to save anyway.`,
          );
        }
      }

      const now = this.nowIso();
      let entry: ProgressEntry;
      if (existing) {
        entry = {
          ...existing,
          date: input.date,
          quantity: input.quantity,
          unit: input.unit as Unit,
          remarks,
          photos: input.photos,
          status: 'Draft',
          updatedAt: now,
          history: [...existing.history, this.hist(role, 'Edited', existing.status === 'Returned' ? 'Corrected after return' : undefined)],
        };
      } else {
        entry = {
          id: this.nextId('DPR'),
          clientRequestId: input.clientRequestId,
          projectId: input.projectId,
          modelKey: model.key,
          modelId: model.modelId,
          modelRevision: model.revision,
          elementId: element.id,
          elementCode: element.code,
          elementType: element.type,
          activityCode: activity.code,
          activityName: activity.name,
          date: input.date,
          quantity: input.quantity,
          unit: input.unit as Unit,
          remarks,
          status: 'Draft',
          photos: input.photos,
          createdAt: now,
          updatedAt: now,
          history: [this.hist(role, 'Created')],
        };
      }
      if (input.submit) {
        entry = { ...entry, status: 'Submitted', history: [...entry.history, this.hist(role, 'Submitted')] };
      }

      const next = existing ? all.map((e) => (e.id === entry.id ? entry : e)) : [...all, entry];
      this.write(K.entries, next);
      this.remember(input.clientRequestId, [entry.id]);
      return entry;
    });
  }

  saveBatchEntries(input: SaveBatchInput, role: Role) {
    return this.op(() => {
      const replay = this.replayed(input.clientRequestId);
      if (replay?.length) return replay;

      if (!permissions.canCreate(role)) {
        throw new RepositoryError('forbidden', `${ROLE_LABELS[role]} cannot create progress entries (demo role rules).`);
      }
      const { model, elements, activities } = this.activeContext(input.projectId);
      const activity = this.findActivity(activities, input.activityCode);
      const selected = input.elementIds.map((id) => this.findElement(elements, id));

      if (input.mode === 'total' && !input.allocationMethod) {
        throw new RepositoryError('validation', 'Choose how the total is allocated: manual allocation or an equal split.');
      }
      const resolved = resolveBatchQuantities(input.mode, input.value, input.elementIds, input.mode === 'total' ? input.allocations : undefined);
      if (!resolved.ok) throw new RepositoryError('validation', resolved.errors);

      const scope = this.entries().filter((e) => inModelFamily(e, model));
      const remarks = input.remarks.trim();
      const errors: string[] = [...validateDate(input.date, isoDate(this.now()))];
      if (remarks.length > 500) errors.push('Remarks must be 500 characters or fewer.');
      for (const el of selected) {
        checkQuantity({
          element: el,
          activity,
          quantity: resolved.quantities[el.id],
          unit: input.unit,
          entries: scope,
          mode: 'claim',
        }).forEach((m) => errors.push(m.startsWith(el.code) ? m : `${el.code}: ${m}`));
      }
      if (errors.length) throw new RepositoryError('validation', [...new Set(errors)]);

      if (!input.confirmDuplicate) {
        const dups = selected
          .map((el) => findPossibleDuplicate(scope, { elementId: el.id, activityCode: activity.code, date: input.date, quantity: resolved.quantities[el.id] }))
          .filter((d): d is ProgressEntry => !!d);
        if (dups.length) {
          throw new RepositoryError(
            'possible-duplicate',
            `Identical entries already exist for ${dups.map((d) => `${d.elementCode} (${d.id}, ${d.status})`).join(', ')}. Confirm this is separate work to save anyway.`,
          );
        }
      }

      const now = this.nowIso();
      const batchId = this.nextId('BATCH');
      const mode = input.mode === 'per-element' ? 'per-element' : input.allocationMethod === 'equal' ? 'total-equal' : 'total-manual';
      const created: ProgressEntry[] = selected.map((el) => {
        const history = [this.hist(role, 'Created', `Multi-element entry ${batchId}`)];
        if (input.submit) history.push(this.hist(role, 'Submitted'));
        return {
          id: this.nextId('DPR'),
          clientRequestId: input.clientRequestId,
          projectId: input.projectId,
          modelKey: model.key,
          modelId: model.modelId,
          modelRevision: model.revision,
          elementId: el.id,
          elementCode: el.code,
          elementType: el.type,
          activityCode: activity.code,
          activityName: activity.name,
          date: input.date,
          quantity: resolved.quantities[el.id],
          unit: input.unit as Unit,
          remarks,
          status: input.submit ? 'Submitted' : 'Draft',
          photos: input.photos,
          batch: {
            id: batchId,
            mode,
            elementCount: selected.length,
            ...(input.mode === 'total' ? { total: input.value } : { perElement: input.value }),
          },
          createdAt: now,
          updatedAt: now,
          history,
        };
      });
      this.write(K.entries, [...this.entries(), ...created]);
      this.remember(input.clientRequestId, created.map((e) => e.id));
      return created;
    });
  }

  submitProgressEntry(entryId: string, role: Role) {
    return this.op(() => {
      const all = this.entries();
      const entry = all.find((e) => e.id === entryId);
      if (!entry) throw new RepositoryError('not-found', `Entry ${entryId} was not found.`);
      if (entry.status === 'Submitted') throw new RepositoryError('conflict', `Entry ${entryId} has already been submitted.`);
      if (!permissions.canSubmit(role, entry)) {
        throw new RepositoryError('forbidden', `${ROLE_LABELS[role]} cannot submit an entry that is ${entry.status}.`);
      }
      const { elements, activities, model } = this.activeContext(entry.projectId);
      if (!inModelFamily(entry, model)) {
        throw new RepositoryError('conflict', `Entry ${entryId} was recorded on model ${entry.modelId} ${entry.modelRevision}, which is no longer active. It is kept as history and cannot be submitted.`);
      }
      const errors = checkQuantity({
        element: this.findElement(elements, entry.elementId),
        activity: this.findActivity(activities, entry.activityCode),
        quantity: entry.quantity,
        unit: entry.unit,
        entries: all.filter((e) => inModelFamily(e, model)),
        excludeEntryId: entry.id,
        mode: 'claim',
      });
      if (errors.length) throw new RepositoryError('validation', errors);
      const updated: ProgressEntry = {
        ...entry,
        status: 'Submitted',
        updatedAt: this.nowIso(),
        history: [...entry.history, this.hist(role, 'Submitted')],
      };
      this.write(K.entries, all.map((e) => (e.id === entryId ? updated : e)));
      return updated;
    });
  }

  reviewProgressEntry(entryId: string, decision: 'approve' | 'return', remarks: string, role: Role) {
    return this.op(() => {
      const all = this.entries();
      const entry = all.find((e) => e.id === entryId);
      if (!entry) throw new RepositoryError('not-found', `Entry ${entryId} was not found.`);
      if (entry.status !== 'Submitted') {
        throw new RepositoryError('conflict', `Entry ${entryId} is ${entry.status}; only Submitted entries can be reviewed.`);
      }
      if (!permissions.canReview(role, entry)) {
        throw new RepositoryError('forbidden', `${ROLE_LABELS[role]} cannot review entries (demo role rules).`);
      }
      const note = remarks.trim();
      if (decision === 'return' && !note) {
        throw new RepositoryError('validation', 'Enter a reason so the site engineer knows what to correct.');
      }
      if (decision === 'approve') {
        const { elements, activities, model } = this.activeContext(entry.projectId);
        if (!inModelFamily(entry, model)) {
          throw new RepositoryError('conflict', `Entry ${entryId} belongs to model ${entry.modelId} ${entry.modelRevision}, which is not the active model.`);
        }
        const errors = checkQuantity({
          element: this.findElement(elements, entry.elementId),
          activity: this.findActivity(activities, entry.activityCode),
          quantity: entry.quantity,
          unit: entry.unit,
          entries: all.filter((e) => inModelFamily(e, model)),
          excludeEntryId: entry.id,
          mode: 'approve',
        });
        if (errors.length) throw new RepositoryError('validation', errors);
      }
      const updated: ProgressEntry = {
        ...entry,
        status: decision === 'approve' ? 'Approved' : 'Returned',
        reviewRemarks: note || undefined,
        updatedAt: this.nowIso(),
        history: [...entry.history, this.hist(role, decision === 'approve' ? 'Approved' : 'Returned', note || undefined)],
      };
      this.write(K.entries, all.map((e) => (e.id === entryId ? updated : e)));
      return updated;
    });
  }

  deleteDraftEntry(entryId: string, role: Role) {
    return this.op(() => {
      const all = this.entries();
      const entry = all.find((e) => e.id === entryId);
      if (!entry) throw new RepositoryError('not-found', `Entry ${entryId} was not found.`);
      if (!permissions.canDelete(role, entry)) {
        throw new RepositoryError('forbidden', `Only Draft entries can be deleted by the site engineer (this one is ${entry.status}).`);
      }
      this.write(K.entries, all.filter((e) => e.id !== entryId));
    });
  }

  async resetDemoData() {
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => this.storage.removeItem(k));
    if (this.onReset) await this.onReset();
    this.ready = null;
    await this.init();
  }
}

function isoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Minimal in-memory Storage implementation (tests, or when localStorage is unavailable). */
export class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
}

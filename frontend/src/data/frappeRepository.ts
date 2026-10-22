import type { ElementRecord, ModelRecord, ProgressEntry, Project, Role } from '../domain/types';
import { elementsFromModel } from './elements';
import { call } from './frappeApi';
import {
  RepositoryError,
  type ImportModelInput,
  type ImportModelOutcome,
  type PmcRepository,
  type SaveBatchInput,
  type SaveEntryInput,
} from './repository';

const M = 'api.';

/** The server sends null where the local repository leaves a field out; the UI treats both the same. */
const clean = <T>(e: T): T => {
  const o = e as Record<string, unknown>;
  for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
  return e;
};

/**
 * PmcRepository backed by the pmc_3d_progress Frappe app (pmc_3d_progress/api.py). Same interface and
 * shapes as LocalRepository, so the UI is unchanged; every rule is checked again on the server.
 */
export class FrappeRepository implements PmcRepository {
  listProjects() {
    return call<Project[]>(`${M}list_projects`, {}, 'GET');
  }

  getProject(projectId: string) {
    return call<Project | null>(`${M}get_project`, { project_id: projectId }, 'GET');
  }

  async listModels(projectId?: string) {
    return (await call<ModelRecord[]>(`${M}list_models`, projectId ? { project_id: projectId } : {}, 'GET')).map(clean);
  }

  async getProjectModel(projectId: string) {
    const m = await call<ModelRecord | null>(`${M}get_project_model`, { project_id: projectId }, 'GET');
    return m ? clean(m) : null;
  }

  async listElements(projectId: string): Promise<ElementRecord[]> {
    const model = await this.getProjectModel(projectId);
    return model ? elementsFromModel(model) : [];
  }

  importModel(input: ImportModelInput) {
    return call<ImportModelOutcome>(`${M}import_model`, {
      text: input.text,
      source_name: input.sourceName,
      source_type: input.sourceType,
      target_project_id: input.targetProjectId ?? null,
    });
  }

  async setActiveModel(modelKey: string) {
    await call(`${M}set_active_model`, { model_key: modelKey });
  }

  async listProgressEntries(projectId: string, opts?: { modelKey?: string }) {
    return (await call<ProgressEntry[]>(`${M}list_progress_entries`, { project_id: projectId, model_key: opts?.modelKey }, 'GET')).map(clean);
  }

  async listAllProgressEntries() {
    return (await call<ProgressEntry[]>(`${M}list_all_progress_entries`, {}, 'GET')).map(clean);
  }

  async saveProgressEntry(input: SaveEntryInput, role: Role) {
    return clean(await call<ProgressEntry>(`${M}save_progress_entry`, { input, role }));
  }

  async saveBatchEntries(input: SaveBatchInput, role: Role) {
    return (await call<ProgressEntry[]>(`${M}save_batch_entries`, { input, role })).map(clean);
  }

  async submitProgressEntry(entryId: string, role: Role) {
    return clean(await call<ProgressEntry>(`${M}submit_progress_entry`, { entry_id: entryId, role }));
  }

  async reviewProgressEntry(entryId: string, decision: 'approve' | 'return', remarks: string, role: Role) {
    return clean(await call<ProgressEntry>(`${M}review_progress_entry`, { entry_id: entryId, decision, remarks, role }));
  }

  async deleteDraftEntry(entryId: string, role: Role) {
    await call(`${M}delete_draft_entry`, { entry_id: entryId, role });
  }

  async resetDemoData(): Promise<void> {
    // Shared server data is never wiped from the page; administrators delete records in Frappe Desk.
    throw new RepositoryError('forbidden', 'Clearing all data is not available on the server.');
  }
}

export interface SessionInfo {
  user: string;
  fullName: string;
  roles: Role[];
  aiConfigured: boolean;
}

export const getSession = () => call<SessionInfo>(`${M}get_session`, {}, 'GET');

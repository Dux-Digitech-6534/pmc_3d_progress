# ERPNext / Frappe integration notes

The prototype is local-only. Nothing here talks to ERPNext yet, and there are **no fake
endpoints** in the code. This document describes how the local repository would be
replaced by a Frappe-backed one.

## 1. Where the seam is

The UI only uses the `PmcRepository` interface (`src/data/repository.ts`):

| Method | Purpose |
|---|---|
| `listProjects()`, `getProject(id)` | Projects |
| `listModels(projectId?)`, `getProjectModel(projectId)` | Model register / active revision |
| `listElements(projectId)` | Elements of the active revision |
| `importModel(input)`, `setActiveModel(key)` | Model import and revision switch |
| `listProgressEntries(projectId, {modelKey?})`, `listAllProgressEntries()` | DPR lines |
| `saveProgressEntry(input, role)`, `saveBatchEntries(input, role)` | Create/edit drafts (optionally submit) |
| `submitProgressEntry(id, role)` | Draft → Submitted |
| `reviewProgressEntry(id, decision, remarks, role)` | Submitted → Approved / Returned |
| `deleteDraftEntry(id, role)` | Remove a draft |
| `resetDemoData()` | Prototype only — not implemented on a server |

`src/data/appRepository.ts` is the only place the concrete repository is chosen. A
`FrappeRepository implements PmcRepository` would be dropped in there; no component changes.

The `role` argument exists only because the prototype has a demo role switch. A Frappe
repository ignores it — the server knows the logged-in user and their roles.

## 2. Suggested record mapping

| Prototype | ERPNext / Frappe | Notes |
|---|---|---|
| `Project` | standard **Project** | `project.id` ↔ Project name (or a custom `pmc_project_code` field) |
| `ModelRecord` | custom DocType **PMC Model** | fields: project (Link Project), model_id, revision, source_type, source file (Attach), import_status, imported_on, warnings (Long Text), element_count. Unique: (project, model_id, revision) |
| Building / Level | child tables on PMC Model, or custom **PMC Building / PMC Level** | depends on scope |
| `ElementRecord` | custom DocType **PMC Element** | fields: pmc_model (Link), source_element_id, code, element_type (Select), building, level, geometry (JSON), notes; child table **PMC Element Planned Qty** (activity, quantity, uom). Unique: (pmc_model, source_element_id) |
| Activity template | custom **PMC Activity** (code, name, UOM) | Reinforcement/kg, Shuttering/m², Concreting/m³; client to approve list |
| `ProgressEntry` | custom DocType **PMC DPR** (header: project, pmc_model, date) + child rows **PMC DPR Item** (pmc_element, activity, qty, uom, remarks) — or one DocType per line | Workflow: Draft → Submitted → Approved / Returned |
| Photos | Frappe **File** attached to the PMC DPR | via `/api/method/upload_file` |
| `batch` info | fields on the DPR (allocation_mode, entered_total) | keeps the "total vs per element" decision auditable |

**Permanent identity** = project + PMC Model (model_id + revision) + `source_element_id`.
Never use display codes (C-01) or Three.js object ids as keys.

## 3. Server responsibilities (must not stay in the browser)

Everything the local repository checks must be re-checked on the server, because the
browser can be bypassed:

- Role and project permission checks (Frappe roles, User Permissions on Project, DocType permissions).
- Workflow transitions via a Frappe **Workflow** on PMC DPR (Site Engineer submits; PMC Reviewer approves/returns; Owner read-only).
- Quantity validation (`checkQuantity` in `src/domain/workflow.ts`): positive, max 3 decimals, unit = activity UOM, planned quantity configured, approved + submitted + this ≤ planned. Re-check at approval time.
- Batch allocation validation (`resolveBatchQuantities` in `src/domain/allocation.ts`): totals must be allocated, never copied per element.
- Idempotency: store the client's `clientRequestId` on the DPR (unique index) so a retried request returns the existing record.
- Revision rules: an entry's element must belong to the PMC Model it references; approving an entry on a superseded model revision is refused.
- Model import validation (`validateModelDocument` in `src/domain/modelValidation.ts`) — run it server-side on the uploaded file before creating PMC Element records.

The pure functions in `src/domain/` are framework-free TypeScript; port them to Python
(or call shared tests against both) so client and server rules stay identical.

## 4. Sketch of a Frappe repository (not implemented)

```ts
// src/data/frappeRepository.ts — illustrative only
export class FrappeRepository implements PmcRepository {
  constructor(private baseUrl = '') {} // same-origin when served as a Frappe page/portal

  private async call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/method/pmc_app.api.${method}`, {
      method: 'POST',
      credentials: 'include',                       // Frappe session cookie, no API keys in the frontend
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': (window as any).csrf_token },
      body: JSON.stringify(args),
    });
    const body = await res.json();
    if (!res.ok) throw new RepositoryError('validation', parseFrappeMessages(body));
    return body.message as T;
  }

  listElements(projectId: string) {
    return this.call<ElementRecord[]>('list_elements', { project: projectId });
  }
  saveProgressEntry(input: SaveEntryInput) {
    return this.call<ProgressEntry>('save_progress_entry', input);
  }
  // …one whitelisted, permission-checked server method per interface method
}
```

Server side (custom app `pmc_app`): `@frappe.whitelist()` methods that check
`frappe.has_permission`, validate, and insert/submit documents. Do **not** expose
generic `/api/resource` writes for PMC DPR to the browser without those checks, and do
**not** put API keys/secrets in frontend code — use the logged-in session.

## 5. Model files in ERPNext

1. "Upload Model" on the Project → file stored with Frappe File (private).
2. A PMC Model record is created with status *Importing*; a background job validates the file.
3. On success, PMC Element rows are created and the model becomes *Active*; the previous revision becomes *Superseded*.
4. The viewer page loads geometry + element records for the active revision and maps clicks by `source_element_id`.

Real CAD/BIM sources (IFC, RVT, DWG, SKP) need a conversion step that **preserves stable
element ids and properties** (e.g. IFC GlobalId). That is a separate deliverable and is not
implemented here. A GLB/glTF route would need either ids in node `extras` or a companion
mapping file validated the same way as this JSON format.

## 6. Historical progress and revisions

- Every DPR line stores the model key (project + model id + revision) it was recorded on.
- Progress and colours are computed only from entries of the active revision.
- Moving progress to a new revision must be an explicit, reviewed migration (compare added/removed/changed elements first). The prototype never does it automatically.

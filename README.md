# PMC 3D Progress — local prototype

A desktop-first web prototype for **construction Project Management Consultancy (PMC)**:
open a project, view its 3D structural model, click a footing / column / beam / slab, see its
planned and approved quantities, record daily progress, and review it through a
Draft → Submitted → Approved / Returned workflow.

Everything runs locally in the browser with mock data. **No server, cloud database,
account, API key or ERPNext instance is needed.** The data layer is behind a repository
interface so it can later be pointed at ERPNext/Frappe (see
[docs/ERPNEXT_INTEGRATION.md](docs/ERPNEXT_INTEGRATION.md)).

> The sample security cabins are conceptual demonstration models, **not engineering-approved
> designs**. Quantities are illustrative.

## Run it

Requires Node.js 20.19+ or 22.12+ (tested with Node 24).

```bash
npm install
npm run dev          # http://localhost:5183
```

Other commands:

```bash
npm test             # unit tests (Vitest): progress, workflow totals, bulk allocation, import, persistence
npm run build        # type-check + production build into dist/
npm run preview      # serve the production build on http://localhost:5184
npm run generate:samples   # regenerate the two sample model JSON files
```

## Single-file version (no server)

```bash
npm run build:standalone   # → standalone/PMC-3D-Progress.html
```

One self-contained HTML file (~0.9 MB, all JS/CSS/sample models inlined, no internet needed).
Copy it anywhere (USB, another PC, email) and double-click to open in Chrome or Edge. Data is
saved in that browser for that file location only — it is not shared with the `npm run dev`
version or with other computers. (`npm audit` flags `braces`, a build-time dependency of
`vite-plugin-singlefile`; no fixed version exists yet and none of it is in the HTML.)

## Getting started (the app starts empty)

There is no demo data any more. On first open you see a welcome screen:
1. **Model Builder** → upload the project drawing (PDF or photo).
2. **Read drawing with AI** → the form (grid, columns, footings, beams, slab, walls, doors, windows, lintels, chhajjas) is filled from the drawing. Check it, especially the listed assumptions.
3. **Create model** → the project is created and the 3D model opens.

*Load demo data instead* (welcome screen) brings back the two sample cabins; **Clear all data** (sidebar) empties the app again (the AI key is kept).

### Reading the drawing with AI

- Uses Claude (`claude-opus-5-5`, effort `high`) through the official `@anthropic-ai/sdk` in the browser, with structured outputs (a zod schema, `src/ai/drawingSchema.ts`) so the answer is always form data, and server-side refusal fallback (`fallbacks: "default"`). Code: `src/ai/drawingReader.ts`.
- Needs internet and **your own Anthropic API key** (console.anthropic.com). Each reading is billed to that key. The key is stored only in this browser (`localStorage` key `pmc3d.anthropicApiKey`) and sent only to api.anthropic.com — do not save it on a shared computer. *Forget key* removes it.
- PDFs are sent as documents; photos / scans are scaled to at most 2400 px. Up to ~30 MB of drawings per reading.
- The AI is not perfect: it lists every value it assumed, positions it could not place are reported, and the form can be undone. An engineer must check the values before creating the model.
- In ERPNext this call must move to the server (a whitelisted method) so no API key ever reaches a browser.

## Model Builder — build a model from a PDF / image drawing

Most projects only have drawings (PDF, or a photo / scan as JPG/PNG), not a model file. **Model Builder** (sidebar) handles this:

1. **Upload** the structural and/or GA drawing (PDF, JPG, PNG, WebP, up to 20 MB, several files allowed). It is stored with the project in this browser (IndexedDB `pmc3d-drawings`) and shown next to the form — PDFs in the browser's own PDF viewer, images with zoom.
2. **Read the values off the drawing** into the form: grid spacings (mm), the column schedule (C1 300×300 → footing F1), the footing schedule (F1 1400×1400, D 300), which column stands at each grid point, footing depth, roof level, plinth / roof beam sizes, slab thickness, and a kg/m³ steel rate per element type until the BBS is available.
3. **Walls, doors and windows** (section 5, **off by default** — the model is the structural frame only; tick "Brick walls" to add them): brick walls (thickness, outer or also internal grid lines) between column faces from plinth top to roof beam soffit; the door / window / ventilator schedule (mark, width, height, sill — e.g. D 900×2100, W 1500×1200 sill 900, V 600×450 sill 1800); where each opening sits (wall + distance from the wall's first grid point, or centred); RCC lintels over openings (depth, bearing) and chhajjas on outer walls (projection, thickness, over doors too). Openings are really cut through the walls in 3D.
4. A **live 3D preview** and the totals (concrete m³, shuttering m², steel kg, brickwork m³, plaster m²) update as you type.
5. **Create model** sends the generated document through the normal import (validation, revisions, Model Register). Element IDs follow the grid (`…-COL-X1Y1`), so a corrected drawing becomes **R02** with the same IDs. Choosing an existing project under *Start from* reloads the form of a model built here and moves to the next revision.

Orientation: X1 is on the left and **Y1 is the front** (bottom edge of the plan), facing the default camera.
Activities are per element type: walls get *Brickwork* (m³, net of openings and lintels) and *Plaster* (m², both faces, net of openings); doors and windows get *Fixing* (nos); footings, columns, beams, slab, lintels and chhajjas get Reinforcement / Shuttering / Concreting. Activities that do not apply show as *Not applicable* and cannot be entered.

The drawing is not read automatically: a PDF / image has no element identities, sizes or levels a program can rely on, so an engineer enters them. Logic: `src/domain/modelBuilder.ts`, tests: `tests/modelBuilder.test.ts`.

## Stack

React 19.2 · TypeScript 5.9 · Vite 7.3 · Three.js 0.185 (plain Three.js + OrbitControls +
CSS2DRenderer for labels) · idb-keyval (photo blobs in IndexedDB) · Vitest 4.
Versions are pinned exactly in `package.json`.

## A 5-minute demo script

1. **3D Workspace** (Security Cabin A, role *Site Engineer*). Footings are green (concreting
   approved). Click column **C-01** in 3D — it highlights blue, the list row is ticked and the
   right panel shows C-01 (stable id `SCA-C001`, R01, planned/approved/remaining per activity).
2. In the entry form choose *Concreting*, enter `5` → blocked: exceeds the 0.19 m³ plan.
   Enter `0.1` → **Save & submit**. Concreting still shows *Not started* with "0.1 awaiting review".
3. Switch role to **PMC Reviewer** → history → **Review** → **Approve**. C-01 concreting becomes
   *In progress 52.6%* and turns orange in 3D.
4. Back to *Site Engineer*. Tick **C-02, C-03, C-04** (or Ctrl/⌘-click them in 3D). Choose
   *Concreting*, **Total across the selection** = `0.3`, **Split equally** → 0.1 each.
   (Typing 0.3 into every row is rejected: "Allocated 0.9 does not match the entered total 0.3".)
5. **Dashboard** as **Owner**: per-activity progress in its own unit, pending reviews, today's work.
   Drafts are listed but not counted.
6. **Model Register** → *Try an invalid file* (see the validation errors) → *Import Security
   Cabin B* → the same app now shows a 27-element building. No code change.
7. **Daily Progress Reports**: search, filter by status/date/activity, view details, **Export CSV**.
8. Reload the page — everything is still there. **Reset Demo Data** restores the seed.

## Features implemented

**Layout** — sidebar (Dashboard, Projects, 3D Workspace, Daily Progress Reports, Model
Register); top bar with project selector, project name + model revision, demo role selector
and a **Local Demo** badge; 3-pane workspace (element list & filters · 3D viewer · details & entry).
Responsive down to tablet/phone width (panes stack).

**Projects** — two sample projects (Cabin A: 13 elements, Cabin B: 27 elements, different ids,
dimensions and layout). Switching projects clears the selection and loads only that project's
model and records.

**3D viewer** — procedural geometry built from the model JSON; rotate / zoom / pan; reset camera;
click to select; Ctrl/⌘-click to multi-select/toggle; list ↔ 3D selection kept in sync (list
scrolls to 3D picks); filters by type, level, search and activity status (filtered-out elements
become faint and unpickable); selected count, Clear selection, Esc to clear; labels toggle;
hover tooltip; colour mode by element type or by an activity (grey not started, orange in
progress, green complete, lavender not configured) with a legend that has text labels and counts.
WebGL failure shows an explanatory message instead of a blank area.

**Element details** — code, stable id, type, project, building & level, model + revision,
size, notes; per activity: planned, approved, remaining, awaiting review, status and %; full
progress history with workflow badges and PMC remarks; count of entries on older revisions.

**Daily progress entry** — date (no future dates), element, activity, quantity, unit, remarks,
up to 3 photos. Live validation. Photos are previewed as *Not saved yet* and are written to
IndexedDB only when the entry is saved; the write is read back to verify, and the entry is not
saved if photo storage fails. Edit Draft/Returned entries; delete drafts.

**Workflow** — Draft → Submitted → Approved / Returned (return requires a reason); Returned →
edit → resubmit. Demo roles: Site Engineer (create/edit/submit), PMC Reviewer (approve/return),
Owner (view). **The role switch only demonstrates the workflow — it is not authentication or
security.**

**Multi-element entries** — the user must explicitly choose *Total across the selection* or
*Quantity per element*. Totals need an allocation (manual table or an explicitly chosen equal
split; remainder distributed so the parts sum exactly). The allocation must match the total.
Each element is validated against its own plan; the batch is atomic (all or nothing).

**Progress rules** (`src/domain/progress.ts`, `src/domain/workflow.ts`)
- progress = approved quantity ÷ planned quantity × 100, per element **and** activity;
- only *Approved* entries count; Draft, Submitted and Returned never change approved totals;
- missing/zero/wrong-unit planned quantity → *Not configured* (no %), and entries are refused;
- negative/zero/non-numeric quantities and unit mismatches are invalid;
- approved + awaiting-review + new quantity may not exceed the plan (clear message with the numbers); re-checked at approval;
- duplicate protection: a per-action idempotency key (retries/double-clicks return the same record), a synchronous double-click guard, re-submit of a submitted entry is refused, and an identical element/activity/date/quantity entry needs explicit confirmation;
- returns and edits recalculate automatically (totals are always derived, never stored);
- kg, m² and m³ are never added together; the dashboard shows each activity separately and has no invented overall %.

**Dashboard** — element counts by type, per-activity planned/approved/awaiting review and
status counts, pending reviews, today's reported work.

**DPR list** — date, project, element, activity, quantity + unit, status, remarks; search;
status, activity and date-range filters; current project or all projects; details/review
dialog; "Show in 3D"; CSV export (UTF-8 BOM, quoted, formula-injection safe).

**Model register & import** — model name, project, model id, revision, import date, source
type, element count, import status (Active / Superseded / Failed, failed imports keep their
errors). Import from a `.json` file or the bundled samples (same pipeline), download both
samples and an intentionally invalid example. New revisions supersede the old one without
moving its progress; superseded revisions can be re-activated.

**Persistence** — localStorage keys prefixed `pmc3d.v1.`; photos in IndexedDB database
`pmc3d-photos`. **Reset Demo Data** (with confirmation) removes only those keys and that
database, then reseeds. If localStorage is blocked, a banner warns that nothing will survive a reload.

## Data schema

- Model import format: [docs/MODEL_FORMAT.md](docs/MODEL_FORMAT.md) (with validation rules and
  sample files in `src/data/samples/`).
- Runtime types: `src/domain/types.ts`. Stored records:

| Store key | Content |
|---|---|
| `pmc3d.v1.projects` | `Project[]` — id, name, location, client, activeModelKey |
| `pmc3d.v1.models` | `ModelRecord[]` — key (`project|model|revision`), status, source, warnings/errors, validated document |
| `pmc3d.v1.entries` | `ProgressEntry[]` — id, clientRequestId, project/model/revision keys, stable element id + code, activity, date, quantity, unit, remarks, status, photo metadata, batch info, review remarks, history |
| `pmc3d.v1.meta` | id sequence, seed timestamp, processed request ids (idempotency) |
| `pmc3d.v1.ui` | last project, page and demo role (convenience only) |
| IndexedDB `pmc3d-photos` | photo blobs keyed by photo id |

## Project structure

```
src/
  domain/        framework-free rules: types, progress, allocation, workflow, model validation
  data/          repository interface, LocalRepository (localStorage), seed, samples, photo store
  components/    ModelViewer (Three.js), ElementPanel, EntryForm, BulkEntryForm, dialogs, UI bits
  pages/         Dashboard, Projects, Workspace, DprList, ModelRegister
  state/         AppContext (current project, role, selection, data loading)
tests/           Vitest unit tests (38)
scripts/         sample model generator
docs/            model format, ERPNext integration notes
```

## Assumptions

- Activities are Reinforcement (kg), Shuttering (m²), Concreting (m³); the list is data-driven per model.
- An activity is *Complete* when approved quantity reaches the planned quantity.
- Quantities use up to 3 decimals; entries above plan are blocked (a plan error should be fixed by a model revision, not by over-reporting).
- Clicking empty space in 3D keeps the current selection (use *Clear selection* or Esc).
- Future-dated entries are rejected; back-dated entries are allowed.
- Approved entries are immutable in the prototype (a correction would be a reversal entry in ERPNext).

## Limitations (not implemented)

- No real authentication, users or permissions — the role switch is a demo only.
- No server; data is per-browser and per-device. Clearing site data loses it.
- Only the documented JSON box format is imported. **No IFC, RVT, DWG, SKP or GLB/glTF import.**
- Geometry is axis-aligned boxes and straight walls with rectangular openings. No sloped / curved members, stairs, finishes, MEP or furniture.
- No revision diff/migration tool; progress on old revisions is kept as history only.
- No labour headcount, BOQ, billing, procurement, scheduling, or structural design checks (out of scope).
- Photos are limited to 3 × 2 MB per entry and are not compressed.
- Desktop-first; usable on tablets, not optimised for phones or offline field use.

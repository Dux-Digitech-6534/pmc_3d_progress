# Working locally and putting changes on production

The same code runs in three places, all on the `main` branch of
[Dux-Digitech-6534/pmc_3d_progress](https://github.com/Dux-Digitech-6534/pmc_3d_progress):

| Where | Path | What it is |
|---|---|---|
| Local | `C:\Users\Public\pmc-3d-prototype` | the repository: Frappe app (`pmc_3d_progress/`) + React page source (`frontend/`) |
| GitHub | `main` | the shared copy |
| Production | `~/frappe-bench/apps/pmc_3d_progress` on `187.127.132.58`, site `raisonigroup.duxdigitech.in`, page `/pmc-3d` | installed on raisonigroup only |

## 1. Run it locally

```bash
cd frontend
npm install          # once
npm run dev          # http://localhost:5183 — local mode, data in this browser
```

- **Local mode** keeps everything in the browser (no server). Roles are a demo dropdown.
- AI reading in local mode: Model Builder → "Read the drawing with AI" → choose Google Gemini or Anthropic Claude and paste your own key (kept in this browser only).
- `npm run dev:frappe-mock` (http://localhost:5187) runs the **Frappe build** of the page against a small stand-in for the server API — to check the page as it behaves on the server.

### Production data on your computer

`local-data/` (not in Git — it has client drawings) holds a read-only copy of the production data:

- `local-data/production-2026-10-29/model-json/*.json` — every model revision. In the local app open **Model Register → Advanced → Choose JSON file…** to load one; it opens in 3D and in the Model Builder ("Start from" → the project) exactly as on the server.
- `drawings.json` + `files/` — the uploaded drawings (upload them again in the local Model Builder).
- `projects.json`, `elements.json`, `dprs.json`, `settings.json` — the raw records (API keys are not exported).

## 2. Change and test

```bash
cd frontend
npm test             # all unit tests (builder, rooms, materials, approval, AI schema …)
npm run typecheck
```

- Page code: `frontend/src` (Model Builder = `pages/ModelBuilder.tsx`, building logic = `domain/modelBuilder.ts`, materials = `domain/materials.ts`).
- Server code: `pmc_3d_progress/api.py` (data + workflow), `pmc_3d_progress/ai.py` (AI reading).
- The AI instructions exist twice — `frontend/src/ai/drawingReader.ts` (`SYSTEM`) and `pmc_3d_progress/ai.py` (`SYSTEM`); a test fails if they differ. After changing the reading schema run
  `WRITE_AI_SCHEMA=1 npx vitest run tests/aiSchema.test.ts` to refresh `ai_schema.json` / `gemini_schema.json`.
- Python rules: `python3 -m unittest discover -s pmc_3d_progress/tests -t .` (WSL).

## 3. Put it on production

```bash
cd frontend && npm run build:frappe     # builds the page into pmc_3d_progress/public/frontend + www/pmc-3d.html
cd .. && git add -A && git commit -m "…" && git push origin main
```

Then on the server (`ssh frappe@187.127.132.58`):

```bash
cd ~/frappe-bench/apps/pmc_3d_progress && git pull --ff-only origin main
```

- **Only the page changed** (`frontend/`, built assets): nothing more — users refresh with Ctrl+Shift+R.
- **Python changed** (`api.py`, `ai.py`, …): reload the web server and workers — about 4 seconds of downtime for **all six sites on this bench**, so agree a time first. Send SIGTERM to the gunicorn master and the `frappe schedule` / `frappe worker` processes under supervisord; supervisord starts them again.
- **A DocType changed** (`pmc_3d_progress/pmc_3d_progress/doctype/*`): on raisonigroup only,
  `frappe.reload_doc("pmc_3d_progress", "doctype", "<doctype_name>", force=True)` + `frappe.db.commit()` in `bench --site raisonigroup.duxdigitech.in console`, then the reload above.
- Never run `bench migrate` or `bench restart` on this bench: other apps' fixtures and patches run with migrate, and restart needs sudo. If a `bench restart` is run anyway, keep the SSH window open until it finishes — closing it half-way stops the background workers for every site.

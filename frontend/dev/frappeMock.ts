// DEV-ONLY stand-in for the pmc_3d_progress Frappe API, used by `npm run dev:frappe-mock` to click
// through the Frappe build of the page without a Frappe site. It is never part of any build.
//
// It answers /api/method/pmc_3d_progress.api.* and /api/method/upload_file with the same JSON
// shapes and error format as Frappe, backed by the in-memory LocalRepository. It does NOT run the
// Python server code — test that on a real Frappe site (see README "Frappe app").
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Json = Record<string, unknown>;

const EXC: Record<string, [string, number]> = {
  'possible-duplicate': ['PMCPossibleDuplicate', 417],
  conflict: ['PMCConflictError', 417],
  forbidden: ['PermissionError', 403],
  'not-found': ['DoesNotExistError', 404],
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, code: string, messages: string[]) {
  const [excType, status] = EXC[code] ?? ['ValidationError', 417];
  send(res, status, { exc_type: excType, _server_messages: JSON.stringify([JSON.stringify({ message: messages.join('\n') })]) });
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function frappeMock(): Plugin {
  return {
    name: 'pmc-frappe-mock',
    // Frappe puts the session's CSRF token into the page; the mock uses a fixed one.
    transformIndexHtml: (html) => html.replace('</head>', '<script>window.csrf_token = "mock-csrf";</script></head>'),
    configureServer(server: ViteDevServer) {
      let repo: Promise<any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
      const files = new Map<string, { type: string; data: Buffer }>();
      const drawings: Json[] = [];
      const getRepo = () =>
        (repo ??= server.ssrLoadModule('/src/data/localRepository.ts').then((m) => new m.LocalRepository({ storage: new m.MemoryStorage() })));

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname.startsWith('/private/files/')) {
          const f = files.get(url.pathname);
          if (!f) return send(res, 404, {});
          res.setHeader('Content-Type', f.type);
          return res.end(f.data);
        }
        if (!url.pathname.startsWith('/api/method/')) return next();
        if (req.method === 'POST' && !req.headers['x-frappe-csrf-token']) return fail(res, 'forbidden', ['Missing CSRF token (mock).']);

        const raw = req.method === 'POST' ? await body(req) : Buffer.alloc(0);
        if (url.pathname === '/api/method/upload_file') {
          const form = await new Request('http://x', { method: 'POST', headers: req.headers as HeadersInit, body: raw }).formData();
          const file = form.get('file') as File;
          const fileUrl = `/private/files/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
          files.set(fileUrl, { type: file.type, data: Buffer.from(await file.arrayBuffer()) });
          return send(res, 200, { message: { file_url: fileUrl, file_name: file.name, name: fileUrl, file_size: file.size } });
        }

        // ERPNext lists for the material variation report: the local repository's demo ERP data, in get_list shape
        if (url.pathname === '/api/method/frappe.client.get_list') {
          const q = Object.fromEntries(url.searchParams);
          const r = await getRepo();
          if (q.doctype === 'Project') return send(res, 200, { message: (await r.listErpProjects()).map((p) => ({ name: p.id, project_name: p.name })) });
          if (q.doctype === 'Item') return send(res, 200, { message: (await r.listErpItems()).map((i) => ({ name: i.code, item_name: i.name, stock_uom: i.uom })) });
          if (q.doctype === 'Company') return send(res, 200, { message: (await r.listErpCompanies()).map((name) => ({ name })) });
          if (q.doctype === 'Warehouse') {
            const company = (JSON.parse(q.filters || '[]') as unknown[][]).find((f) => f[1] === 'company')?.[3] as string;
            return send(res, 200, { message: (await r.listErpWarehouses(company)).map((name) => ({ name })) });
          }
          const orf = JSON.parse(q.or_filters || '[]') as unknown[][];
          const flt = JSON.parse(q.filters || '[]') as unknown[][];
          const date = (op: string) => flt.find((f) => f[1] === 'posting_date' && f[2] === op)?.[3] as string | undefined;
          const lines = await r.listMaterialSent(String(orf[0]?.[3] ?? ''), date('>='), date('<='));
          const ours = lines.filter((l) => (q.doctype === 'Purchase Receipt') === l.voucher.startsWith('MAT-PRE'));
          return send(res, 200, { message: ours.map((l) => ({ name: l.voucher, posting_date: l.date, item_code: l.itemCode, item_name: l.itemName, qty: l.qty, uom: l.uom })) });
        }

        if (url.pathname === '/api/method/frappe.client.insert') {
          const doc = JSON.parse(raw.toString('utf8') || '{}').doc as {
            company: string;
            schedule_date: string;
            set_warehouse?: string;
            items: { item_code: string; qty: number; uom: string; project?: string }[];
          };
          const r = await getRepo();
          const out = await r.createMaterialRequest({
            company: doc.company,
            requiredBy: doc.schedule_date,
            warehouse: doc.set_warehouse,
            project: doc.items[0]?.project,
            lines: doc.items.map((i) => ({ itemCode: i.item_code, qty: i.qty, uom: i.uom })),
          });
          return send(res, 200, { message: { name: out.name, workflow_state: out.state } });
        }

        // Submit of a saved request: the demo workflow has one forward action
        if (url.pathname === '/api/method/frappe.client.get') return send(res, 200, { message: { name: url.searchParams.get('name'), docstatus: 0 } });
        if (url.pathname === '/api/method/frappe.model.workflow.get_transitions') return send(res, 200, { message: [{ action: 'Approve' }] });
        if (url.pathname === '/api/method/frappe.model.workflow.apply_workflow') {
          const { doc } = JSON.parse(raw.toString('utf8') || '{}') as { doc: { name: string } };
          try {
            const out = await (await getRepo()).submitMaterialRequest(doc.name);
            return send(res, 200, { message: { name: out.name, docstatus: 0, workflow_state: out.state } });
          } catch (e) {
            const err = e as { code?: string; message?: string };
            return fail(res, err.code ?? 'validation', [err.message ?? String(e)]);
          }
        }

        const method = url.pathname.replace('/api/method/pmc_3d_progress.', '');
        const args: Json = req.method === 'POST' ? JSON.parse(raw.toString('utf8') || '{}') : Object.fromEntries(url.searchParams);
        const r = await getRepo();
        try {
          const out = await (async () => {
            switch (method) {
              case 'api.get_session':
                return { user: 'engineer@example.com', fullName: 'Demo Engineer (mock)', roles: ['site-engineer', 'pmc-reviewer', 'owner'], aiConfigured: false };
              case 'api.list_projects':
                return r.listProjects();
              case 'api.get_project':
                return r.getProject(args.project_id);
              case 'api.list_models':
                return r.listModels(args.project_id || undefined);
              case 'api.get_project_model':
                return r.getProjectModel(args.project_id);
              case 'api.import_model':
                return r.importModel({ text: args.text, sourceName: args.source_name, sourceType: args.source_type, targetProjectId: args.target_project_id ?? undefined, role: args.role ?? undefined });
              case 'api.review_model':
                return r.reviewModel(args.model_key, args.decision, args.remarks ?? '', args.role);
              case 'api.set_active_model':
                return r.setActiveModel(args.model_key);
              case 'api.list_progress_entries':
                return r.listProgressEntries(args.project_id, args.model_key ? { modelKey: args.model_key } : undefined);
              case 'api.list_all_progress_entries':
                return r.listAllProgressEntries();
              case 'api.save_progress_entry':
                return r.saveProgressEntry(args.input, args.role);
              case 'api.save_batch_entries':
                return r.saveBatchEntries(args.input, args.role);
              case 'api.submit_progress_entry':
                return r.submitProgressEntry(args.entry_id, args.role);
              case 'api.review_progress_entry':
                return r.reviewProgressEntry(args.entry_id, args.decision, args.remarks, args.role);
              case 'api.delete_draft_entry':
                return r.deleteDraftEntry(args.entry_id, args.role);
              case 'api.get_variation_settings':
                return r.getVariationSettings(args.project_id);
              case 'api.save_variation_settings':
                return r.saveVariationSettings(args.project_id, {
                  erpProject: args.erp_project ?? undefined,
                  itemMap: args.item_map ? JSON.parse(args.item_map) : undefined,
                });
              case 'api.list_drawings':
                return drawings.filter((d) => d.projectId === args.project_id);
              case 'api.add_drawing': {
                const d = {
                  id: `DRW-${drawings.length + 1}`,
                  projectId: args.project_id,
                  name: args.file_name,
                  kind: args.kind,
                  type: args.content_type,
                  size: args.size,
                  uploadedAt: new Date().toISOString(),
                  url: args.file_url,
                };
                drawings.push(d);
                return d;
              }
              case 'api.delete_drawing':
                drawings.splice(drawings.findIndex((d) => d.id === args.drawing_id), 1);
                return null;
              case 'api.reassign_drawings':
                for (const d of drawings) if (d.projectId === args.from_project_id) d.projectId = args.to_project_id;
                return null;
              case 'ai.start_reading':
                throw Object.assign(new Error(), {
                  code: 'validation',
                  details: ['AI reading is not set up on this server. An administrator chooses the AI and enters its API key in PMC Settings.'],
                });
              default:
                throw Object.assign(new Error(), { code: 'not-found', details: [`Unknown method ${method} (mock).`] });
            }
          })();
          send(res, 200, { message: out ?? null });
        } catch (e) {
          const err = e as { code?: string; details?: string[]; message?: string };
          fail(res, err.code ?? 'validation', err.details ?? [err.message ?? String(e)]);
        }
      });
    },
  };
}

import { beforeEach, describe, expect, it } from 'vitest';
import { LocalRepository, MemoryStorage, STORAGE_PREFIX } from '../src/data/localRepository';
import { RepositoryError } from '../src/data/repository';
import { invalidSampleText, SAMPLE_MODELS, sampleText } from '../src/data/samples';
import { computeActivityProgress } from '../src/domain/progress';
import type { ProgressEntry } from '../src/domain/types';
import { todayISO } from '../src/domain/workflow';

const [A, B] = SAMPLE_MODELS;
const ENG = 'site-engineer' as const;
const REV = 'pmc-reviewer' as const;
const OWNER = 'owner' as const;
const today = todayISO();
let n = 0;
const rid = () => `req-${++n}`;

async function setup() {
  const storage = new MemoryStorage();
  const repo = new LocalRepository({ storage });
  const res = await repo.importModel({ text: sampleText(A.json), sourceName: A.fileName, sourceType: 'Bundled sample (procedural JSON)' });
  expect(res.ok).toBe(true);
  const els = await repo.listElements(A.projectId);
  const el = (code: string) => els.find((e) => e.code === code)!;
  return { storage, repo, el };
}

const approvedConc = async (repo: LocalRepository, elementCode: string, activity = 'CONC') => {
  const els = await repo.listElements(A.projectId);
  const element = els.find((e) => e.code === elementCode)!;
  const model = await repo.getProjectModel(A.projectId);
  const act = model!.document!.activities.find((a) => a.code === activity)!;
  const entries = await repo.listProgressEntries(A.projectId, { modelKey: model!.key });
  return computeActivityProgress(element, act, entries);
};

describe('workflow totals', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('only approved entries change approved progress; drafts and submitted do not', async () => {
    const { repo, el } = ctx;
    const c01 = el('C-01');
    const draft = await repo.saveProgressEntry(
      { clientRequestId: rid(), projectId: A.projectId, elementId: c01.id, activityCode: 'CONC', date: today, quantity: 0.05, unit: 'm3', remarks: '', photos: [] },
      ENG,
    );
    expect(draft.status).toBe('Draft');
    expect((await approvedConc(repo, 'C-01')).approved).toBe(0);

    await repo.submitProgressEntry(draft.id, ENG);
    const p1 = await approvedConc(repo, 'C-01');
    expect(p1.approved).toBe(0);
    expect(p1.pendingReview).toBe(0.05);

    await repo.reviewProgressEntry(draft.id, 'approve', '', REV);
    const p2 = await approvedConc(repo, 'C-01');
    expect(p2.approved).toBe(0.05);
    // Only the CONC activity of C-01 changed.
    expect((await approvedConc(repo, 'C-01', 'REINF')).approved).toBe(0);
    expect((await approvedConc(repo, 'C-02')).approved).toBe(0);
  });

  it('a returned entry does not count, and recalculates correctly after correction and approval', async () => {
    const { repo, el } = ctx;
    const e = await repo.saveProgressEntry(
      { clientRequestId: rid(), projectId: A.projectId, elementId: el('F-01').id, activityCode: 'CONC', date: today, quantity: 0.5, unit: 'm3', remarks: '', photos: [], submit: true },
      ENG,
    );
    await repo.reviewProgressEntry(e.id, 'return', 'Recheck volume', REV);
    expect((await approvedConc(repo, 'F-01')).approved).toBe(0);

    const edited = await repo.saveProgressEntry(
      { id: e.id, clientRequestId: rid(), projectId: A.projectId, elementId: el('F-01').id, activityCode: 'CONC', date: today, quantity: 0.4, unit: 'm3', remarks: 'corrected', photos: [], submit: true },
      ENG,
    );
    expect(edited.id).toBe(e.id);
    expect(edited.status).toBe('Submitted');
    await repo.reviewProgressEntry(e.id, 'approve', '', REV);
    expect((await approvedConc(repo, 'F-01')).approved).toBe(0.4);
  });

  it('rejects negative quantities, unit mismatches and quantities above plan', async () => {
    const { repo, el } = ctx;
    const base = { projectId: A.projectId, elementId: el('C-01').id, activityCode: 'CONC', date: today, remarks: '', photos: [] };
    await expect(repo.saveProgressEntry({ ...base, clientRequestId: rid(), quantity: -1, unit: 'm3' }, ENG)).rejects.toThrow(/negative/);
    await expect(repo.saveProgressEntry({ ...base, clientRequestId: rid(), quantity: 0.1, unit: 'kg' }, ENG)).rejects.toThrow(/Unit mismatch/);
    await expect(repo.saveProgressEntry({ ...base, clientRequestId: rid(), quantity: 5, unit: 'm3' }, ENG)).rejects.toThrow(/exceeds the remaining quantity/);
  });

  it('counts submitted quantities when checking the remaining plan', async () => {
    const { repo, el } = ctx;
    const planned = el('C-01').plannedQuantities.CONC.quantity; // 0.19
    const base = { projectId: A.projectId, elementId: el('C-01').id, activityCode: 'CONC', unit: 'm3', remarks: '', photos: [] };
    await repo.saveProgressEntry({ ...base, clientRequestId: rid(), date: today, quantity: 0.15, submit: true }, ENG);
    await expect(
      repo.saveProgressEntry({ ...base, clientRequestId: rid(), date: today, quantity: Math.round((planned - 0.1) * 1000) / 1000 }, ENG),
    ).rejects.toThrow(/awaiting review/);
  });

  it('rejects entries for elements with no planned quantity (Not configured)', async () => {
    const { repo } = ctx;
    const res = await repo.importModel({ text: sampleText(B.json), sourceName: B.fileName, sourceType: 'Uploaded JSON file' });
    expect(res.ok).toBe(true);
    const slab = (await repo.listElements(B.projectId)).find((e) => e.code === 'SL-01')!;
    await expect(
      repo.saveProgressEntry(
        { clientRequestId: rid(), projectId: B.projectId, elementId: slab.id, activityCode: 'REINF', date: today, quantity: 10, unit: 'kg', remarks: '', photos: [] },
        ENG,
      ),
    ).rejects.toThrow(/not configured/);
  });

  it('a retried save with the same clientRequestId does not create a duplicate', async () => {
    const { repo, el } = ctx;
    const input = { clientRequestId: 'same-click', projectId: A.projectId, elementId: el('C-01').id, activityCode: 'CONC', date: today, quantity: 0.05, unit: 'm3', remarks: '', photos: [], submit: true };
    const [x, y] = await Promise.all([repo.saveProgressEntry(input, ENG), repo.saveProgressEntry(input, ENG)]);
    expect(x.id).toBe(y.id);
    expect((await repo.listProgressEntries(A.projectId)).length).toBe(1);
    await expect(repo.submitProgressEntry(x.id, ENG)).rejects.toThrow(/already been submitted/);
  });

  it('flags a possible duplicate (same element/activity/date/qty) unless confirmed', async () => {
    const { repo, el } = ctx;
    const base = { projectId: A.projectId, elementId: el('C-01').id, activityCode: 'CONC', date: today, quantity: 0.05, unit: 'm3', remarks: '', photos: [] };
    await repo.saveProgressEntry({ ...base, clientRequestId: rid() }, ENG);
    const err = await repo.saveProgressEntry({ ...base, clientRequestId: rid() }, ENG).catch((e) => e);
    expect(err).toBeInstanceOf(RepositoryError);
    expect((err as RepositoryError).code).toBe('possible-duplicate');
    const ok = await repo.saveProgressEntry({ ...base, clientRequestId: rid(), confirmDuplicate: true }, ENG);
    expect(ok.status).toBe('Draft');
  });

  it('enforces demo roles: owner cannot create, engineer cannot approve, return needs a reason', async () => {
    const { repo, el } = ctx;
    const base = { clientRequestId: rid(), projectId: A.projectId, elementId: el('C-01').id, activityCode: 'CONC', date: today, quantity: 0.05, unit: 'm3', remarks: '', photos: [] };
    await expect(repo.saveProgressEntry(base, OWNER)).rejects.toThrow(/cannot create/);
    const e = await repo.saveProgressEntry({ ...base, submit: true }, ENG);
    await expect(repo.reviewProgressEntry(e.id, 'approve', '', ENG)).rejects.toThrow(/cannot review/);
    await expect(repo.reviewProgressEntry(e.id, 'return', '  ', REV)).rejects.toThrow(/reason/);
  });
});

describe('multi-element entries', () => {
  it('a total is allocated, not multiplied, across the selection', async () => {
    const { repo, el } = await setup();
    const ids = ['F-01', 'F-02', 'F-03', 'F-04'].map((c) => el(c).id);
    const created = await repo.saveBatchEntries(
      {
        clientRequestId: rid(),
        projectId: A.projectId,
        elementIds: ids,
        activityCode: 'CONC',
        date: today,
        unit: 'm3',
        remarks: '',
        photos: [],
        mode: 'total',
        value: 1.2,
        allocationMethod: 'manual',
        allocations: { [ids[0]]: 0.4, [ids[1]]: 0.3, [ids[2]]: 0.3, [ids[3]]: 0.2 },
        submit: true,
      },
      ENG,
    );
    expect(created).toHaveLength(4);
    const sum = created.reduce((s, e) => s + e.quantity, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(1.2);
    expect(created.every((e) => e.batch?.total === 1.2 && e.batch.mode === 'total-manual')).toBe(true);
  });

  it('rejects a total with no allocation method or a mismatched allocation, and saves nothing', async () => {
    const { repo, el } = await setup();
    const ids = ['F-01', 'F-02'].map((c) => el(c).id);
    const base = { clientRequestId: rid(), projectId: A.projectId, elementIds: ids, activityCode: 'CONC', date: today, unit: 'm3', remarks: '', photos: [], mode: 'total' as const, value: 1 };
    await expect(repo.saveBatchEntries(base, ENG)).rejects.toThrow(/Choose how the total is allocated/);
    await expect(
      repo.saveBatchEntries({ ...base, clientRequestId: rid(), allocationMethod: 'manual', allocations: { [ids[0]]: 1, [ids[1]]: 1 } }, ENG),
    ).rejects.toThrow(/does not match/);
    expect(await repo.listProgressEntries(A.projectId)).toHaveLength(0);
  });

  it('validates every element against its own plan (atomic: none saved if one fails)', async () => {
    const { repo, el } = await setup();
    const ids = ['C-01', 'SL-01'].map((c) => el(c).id); // C-01 CONC planned 0.19 m³
    await expect(
      repo.saveBatchEntries(
        { clientRequestId: rid(), projectId: A.projectId, elementIds: ids, activityCode: 'CONC', date: today, unit: 'm3', remarks: '', photos: [], mode: 'per-element', value: 0.5 },
        ENG,
      ),
    ).rejects.toThrow(/C-01/);
    expect(await repo.listProgressEntries(A.projectId)).toHaveLength(0);
  });
});

describe('projects, models and persistence', () => {
  it('keeps projects separate and needs no code change for the second model', async () => {
    const { repo, el } = await setup();
    const res = await repo.importModel({ text: sampleText(B.json), sourceName: B.fileName, sourceType: 'Uploaded JSON file' });
    expect(res.ok).toBe(true);
    expect(res.createdProject).toBe(true);
    const bEls = await repo.listElements(B.projectId);
    expect(bEls).toHaveLength(B.json.elements.length);
    const aIds = new Set((await repo.listElements(A.projectId)).map((e) => e.key));
    expect(bEls.some((e) => aIds.has(e.key))).toBe(false);

    await repo.saveProgressEntry(
      { clientRequestId: rid(), projectId: A.projectId, elementId: el('C-01').id, activityCode: 'CONC', date: today, quantity: 0.05, unit: 'm3', remarks: '', photos: [] },
      ENG,
    );
    expect(await repo.listProgressEntries(B.projectId)).toHaveLength(0);
    // An element id from project A cannot be used in project B.
    await expect(
      repo.saveProgressEntry(
        { clientRequestId: rid(), projectId: B.projectId, elementId: el('C-01').id, activityCode: 'CONC', date: today, quantity: 0.05, unit: 'm3', remarks: '', photos: [] },
        ENG,
      ),
    ).rejects.toThrow(/not part of the active model/);
  });

  it('survives a "reload" (new repository instance over the same storage)', async () => {
    const { storage, repo, el } = await setup();
    const e = await repo.saveProgressEntry(
      { clientRequestId: rid(), projectId: A.projectId, elementId: el('C-01').id, activityCode: 'CONC', date: today, quantity: 0.05, unit: 'm3', remarks: 'persist me', photos: [], submit: true },
      ENG,
    );
    await repo.reviewProgressEntry(e.id, 'approve', '', REV);
    const reloaded = new LocalRepository({ storage });
    const entries = await reloaded.listProgressEntries(A.projectId);
    expect(entries.map((x: ProgressEntry) => [x.id, x.status, x.remarks])).toEqual([[e.id, 'Approved', 'persist me']]);
  });

  it('reports understandable errors for invalid model data and records the failed import', async () => {
    const { repo } = await setup();
    const res = await repo.importModel({ text: invalidSampleText(), sourceName: 'broken.json', sourceType: 'Uploaded JSON file' });
    expect(res.ok).toBe(false);
    const text = res.errors.join('\n');
    expect(text).toMatch(/duplicate stable element id/);
    expect(text).toMatch(/unsupported type "staircase"/);
    expect(text).toMatch(/geometry.size values must be greater than 0/);
    expect(text).toMatch(/activity is measured in "m3"/);
    expect(text).toMatch(/"levelId" is missing/);
    expect((await repo.listModels()).some((m) => m.status === 'Failed')).toBe(true);
    expect(await repo.listElements(A.projectId)).toHaveLength(A.json.elements.length);
  });

  it('rejects non-JSON, wrong project and re-imports of an existing revision', async () => {
    const { repo } = await setup();
    expect((await repo.importModel({ text: '{oops', sourceName: 'x.json', sourceType: 'Uploaded JSON file' })).errors[0]).toMatch(/not valid JSON/);
    const wrong = await repo.importModel({ text: sampleText(B.json), sourceName: 'b.json', sourceType: 'Uploaded JSON file', targetProjectId: A.projectId });
    expect(wrong.errors[0]).toMatch(/belongs to project "PMC-SEC-002"/);
    const again = await repo.importModel({ text: sampleText(A.json), sourceName: 'a.json', sourceType: 'Uploaded JSON file' });
    expect(again.errors[0]).toMatch(/already imported/);
  });

  it('keeps progress tied to its revision; a new revision starts clean and the old one is superseded', async () => {
    const { repo, el } = await setup();
    const e = await repo.saveProgressEntry(
      { clientRequestId: rid(), projectId: A.projectId, elementId: el('C-01').id, activityCode: 'CONC', date: today, quantity: 0.05, unit: 'm3', remarks: '', photos: [], submit: true },
      ENG,
    );
    await repo.reviewProgressEntry(e.id, 'approve', '', REV);
    const r02 = JSON.parse(sampleText(A.json));
    r02.model.revision = 'R02';
    const res = await repo.importModel({ text: JSON.stringify(r02), sourceName: 'a-r02.json', sourceType: 'Uploaded JSON file' });
    expect(res.ok).toBe(true);
    expect(res.supersededKey).toContain('|R01');
    const model = await repo.getProjectModel(A.projectId);
    expect(model?.revision).toBe('R02');
    expect(await repo.listProgressEntries(A.projectId, { modelKey: model!.key })).toHaveLength(0);
    expect(await repo.listProgressEntries(A.projectId)).toHaveLength(1); // history kept
  });

  it('reset removes only this app\'s keys', async () => {
    const storage = new MemoryStorage();
    storage.setItem('someone-else', 'keep');
    const repo = new LocalRepository({ storage });
    await repo.importModel({ text: sampleText(A.json), sourceName: 'a.json', sourceType: 'Uploaded JSON file' });
    await repo.resetDemoData();
    expect(storage.getItem('someone-else')).toBe('keep');
    for (let i = 0; i < storage.length; i++) expect(storage.key(i)?.startsWith(STORAGE_PREFIX)).toBe(false);
  });
});

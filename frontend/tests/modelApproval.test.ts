import { describe, expect, it } from 'vitest';
import { LocalRepository, MemoryStorage } from '../src/data/localRepository';
import { RepositoryError } from '../src/data/repository';
import { buildModel, defaultSpec, type BuilderSpec } from '../src/domain/modelBuilder';

const text = (over: Partial<BuilderSpec> = {}) => JSON.stringify(buildModel({ ...defaultSpec(), openings: [], ...over }).document);
const submit = (repo: LocalRepository, role: 'site-engineer' | 'pmc-reviewer', over: Partial<BuilderSpec> = {}) =>
  repo.importModel({ text: text(over), sourceName: 'Model Builder', sourceType: 'Model Builder (from drawing)', role });

describe('PMC approval of a planning', () => {
  it("a site engineer's planning waits for the PMC and is not the 3D model yet", async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage() });
    const out = await submit(repo, 'site-engineer');
    expect(out.ok).toBe(true);
    expect(out.record!.status).toBe('Pending Approval');
    expect(await repo.getProjectModel('PMC-SEC-003')).toBeNull();
    await expect(repo.setActiveModel(out.record!.key)).rejects.toBeInstanceOf(RepositoryError);
  });

  it('the PMC returns it with remarks; the corrected planning replaces it; approving makes it active', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage() });
    const first = await submit(repo, 'site-engineer');
    await expect(repo.reviewModel(first.record!.key, 'return', '', 'pmc-reviewer')).rejects.toThrow(/what has to be corrected/);
    await expect(repo.reviewModel(first.record!.key, 'approve', '', 'site-engineer')).rejects.toThrow(/Only the PMC Reviewer/);
    await repo.reviewModel(first.record!.key, 'return', 'Footing F1 is 1200 on the drawing', 'pmc-reviewer');
    let models = await repo.listModels();
    expect(models[0]).toMatchObject({ status: 'Returned', reviewRemarks: 'Footing F1 is 1200 on the drawing' });

    // same revision submitted again replaces the returned one
    const again = await submit(repo, 'site-engineer', { footingTypes: [{ code: 'F1', w: 1200, d: 1200, t: 300 }] });
    expect(again.ok).toBe(true);
    models = await repo.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].status).toBe('Pending Approval');

    await repo.reviewModel(again.record!.key, 'approve', '', 'pmc-reviewer');
    const active = await repo.getProjectModel('PMC-SEC-003');
    expect(active?.key).toBe(again.record!.key);
    expect(active?.status).toBe('Active');
  });

  it("a PMC reviewer's own model is active at once and supersedes the old one", async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage() });
    await submit(repo, 'pmc-reviewer');
    const r2 = await submit(repo, 'pmc-reviewer', { revision: 'R02' });
    expect(r2.record!.status).toBe('Active');
    expect((await repo.listModels()).map((m) => m.status)).toEqual(['Superseded', 'Active']);
  });

  it('an approved revision is never replaced, only a waiting one', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage() });
    await submit(repo, 'pmc-reviewer');
    const out = await submit(repo, 'site-engineer');
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toMatch(/already imported/);
  });
});

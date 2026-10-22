import { describe, expect, it } from 'vitest';
import { LocalRepository, MemoryStorage } from '../src/data/localRepository';
import { seedDemoData } from '../src/data/seed';

describe('demo seed', () => {
  it('creates both projects, imports only Cabin A, and covers every workflow state', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage(), seed: seedDemoData });
    const projects = await repo.listProjects();
    expect(projects.map((p) => p.name)).toEqual(['Security Cabin A', 'Security Cabin B']);
    expect(projects[1].activeModelKey).toBeNull();
    const entries = await repo.listProgressEntries('PMC-SEC-001');
    const statuses = new Set(entries.map((e) => e.status));
    expect([...statuses].sort()).toEqual(['Approved', 'Draft', 'Returned', 'Submitted']);
    expect(await repo.listProgressEntries('PMC-SEC-002')).toHaveLength(0);
  });

  it('reseeds after reset', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage(), seed: seedDemoData });
    const before = (await repo.listAllProgressEntries()).length;
    await repo.resetDemoData();
    expect((await repo.listAllProgressEntries()).length).toBe(before);
  });
});

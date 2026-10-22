import { todayISO } from '../domain/workflow';
import type { LocalRepository } from './localRepository';
import { SAMPLE_MODELS, sampleText } from './samples';

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayISO(d);
};

let n = 0;
const rid = () => `seed-${Date.now()}-${++n}`;

/**
 * Demo data: Cabin A gets its model plus a short, realistic history covering every workflow
 * state. Cabin B is registered as a project WITHOUT a model so the user can demonstrate that
 * importing a second model needs no code change.
 */
export async function seedDemoData(repo: LocalRepository) {
  const [a, b] = SAMPLE_MODELS;
  const imported = await repo.importModel({
    text: sampleText(a.json),
    sourceName: a.fileName,
    sourceType: 'Bundled sample (procedural JSON)',
  });
  if (!imported.ok) throw new Error(`Demo seed failed: ${imported.errors.join(' ')}`);

  await repo.createProject({
    id: b.json.project.id,
    name: b.json.project.name,
    location: b.json.project.location,
    client: b.json.project.client,
  });

  const P = a.projectId;
  const els = await repo.listElements(P);
  const byCode = (code: string) => els.find((e) => e.code === code)!;
  const planned = (code: string, act: string) => byCode(code).plannedQuantities[act].quantity;
  const footings = ['F-01', 'F-02', 'F-03', 'F-04'].map((c) => byCode(c).id);
  const eng = 'site-engineer' as const;
  const rev = 'pmc-reviewer' as const;

  const approveAll = async (ids: string[]) => {
    for (const id of ids) await repo.reviewProgressEntry(id, 'approve', 'Checked on site.', rev);
  };

  // Footings: reinforcement and shuttering complete, entered per element.
  for (const act of ['REINF', 'SHUT'] as const) {
    const batch = await repo.saveBatchEntries(
      {
        clientRequestId: rid(),
        projectId: P,
        elementIds: footings,
        activityCode: act,
        date: daysAgo(6),
        unit: act === 'REINF' ? 'kg' : 'm2',
        remarks: act === 'REINF' ? 'Footing mesh tied and checked for cover.' : 'Footing side shuttering fixed.',
        photos: [],
        mode: 'per-element',
        value: planned('F-01', act),
        submit: true,
      },
      eng,
    );
    await approveAll(batch.map((e) => e.id));
  }

  // Footing concreting: one pour, entered as a TOTAL and split equally.
  const totalConc = footings.length * planned('F-01', 'CONC');
  const pour = await repo.saveBatchEntries(
    {
      clientRequestId: rid(),
      projectId: P,
      elementIds: footings,
      activityCode: 'CONC',
      date: daysAgo(5),
      unit: 'm3',
      remarks: 'M20 pour, all four footings in one pour.',
      photos: [],
      mode: 'total',
      value: Math.round(totalConc * 1000) / 1000,
      allocationMethod: 'equal',
      allocations: Object.fromEntries(footings.map((id) => [id, planned('F-01', 'CONC')])),
      submit: true,
    },
    eng,
  );
  await approveAll(pour.map((e) => e.id));

  // C-01 reinforcement partly approved.
  const c1 = await repo.saveProgressEntry(
    { clientRequestId: rid(), projectId: P, elementId: byCode('C-01').id, activityCode: 'REINF', date: daysAgo(3), quantity: 20, unit: 'kg', remarks: 'Vertical bars placed; ties pending.', photos: [], submit: true },
    eng,
  );
  await approveAll([c1.id]);

  // C-02 reinforcement submitted, waiting for PMC review.
  await repo.saveProgressEntry(
    { clientRequestId: rid(), projectId: P, elementId: byCode('C-02').id, activityCode: 'REINF', date: daysAgo(1), quantity: planned('C-02', 'REINF'), unit: 'kg', remarks: 'Cage complete.', photos: [], submit: true },
    eng,
  );

  // C-03 reinforcement returned by PMC.
  const c3 = await repo.saveProgressEntry(
    { clientRequestId: rid(), projectId: P, elementId: byCode('C-03').id, activityCode: 'REINF', date: daysAgo(2), quantity: 12, unit: 'kg', remarks: 'Partial cage.', photos: [], submit: true },
    eng,
  );
  await repo.reviewProgressEntry(c3.id, 'return', 'Quantity does not match the bar bending schedule — please recheck and resubmit.', rev);

  // C-01 shuttering saved as draft today (must NOT show as progress).
  await repo.saveProgressEntry(
    { clientRequestId: rid(), projectId: P, elementId: byCode('C-01').id, activityCode: 'SHUT', date: daysAgo(0), quantity: 1.5, unit: 'm2', remarks: 'Two faces shuttered so far.', photos: [] },
    eng,
  );
}

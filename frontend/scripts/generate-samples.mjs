// Generates the two procedural sample model JSON files in src/data/samples/.
// Geometry is a set of boxes (one per structural element) in metres, Y axis up,
// ground level at y = 0. Quantities are illustrative only — this is a conceptual
// demonstration model, NOT an engineering-approved design.
//
// Run with: npm run generate:samples
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const r = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const pad = (n) => String(n).padStart(2, '0');
const seq = (n) => String(n).padStart(3, '0');
const qty = (conc, shut, steelPerM3) => ({
  REINF: { quantity: r(conc * steelPerM3, 1), unit: 'kg' },
  SHUT: { quantity: r(shut, 2), unit: 'm2' },
  CONC: { quantity: r(conc, 3), unit: 'm3' },
});

function cabin(o) {
  const elements = [];
  const grid = [];
  o.zs.forEach((z) => o.xs.forEach((x) => grid.push({ x, z })));

  const footingTop = -0.6;
  const colH = o.roofTop - footingTop; // column runs from footing top to slab soffit

  grid.forEach((p, i) => {
    const { w, d, h } = o.footing;
    elements.push({
      id: `${o.prefix}-F${seq(i + 1)}`,
      code: `F-${pad(i + 1)}`,
      type: 'footing',
      buildingId: o.buildingId,
      levelId: 'FDN',
      geometry: { shape: 'box', position: [p.x, r(footingTop - h / 2, 3), p.z], size: [w, h, d] },
      plannedQuantities: qty(w * d * h, 2 * (w + d) * h, 80),
    });
  });

  grid.forEach((p, i) => {
    const { w, d } = o.column;
    elements.push({
      id: `${o.prefix}-C${seq(i + 1)}`,
      code: `C-${pad(i + 1)}`,
      type: 'column',
      buildingId: o.buildingId,
      levelId: 'GF',
      geometry: { shape: 'box', position: [p.x, r(footingTop + colH / 2, 3), p.z], size: [w, r(colH, 3), d] },
      plannedQuantities: qty(w * d * colH, 2 * (w + d) * colH, 180),
    });
  });

  // Beams between neighbouring grid points: along X for each row, then along Z for each column line.
  const spans = [];
  o.zs.forEach((z) => o.xs.slice(0, -1).forEach((x, i) => spans.push({ a: [x, z], b: [o.xs[i + 1], z], axis: 'x' })));
  o.xs.forEach((x) => o.zs.slice(0, -1).forEach((z, i) => spans.push({ a: [x, z], b: [x, o.zs[i + 1]], axis: 'z' })));

  const addBeams = (codePrefix, levelId, centerY, { w, h }) => {
    spans.forEach((s, i) => {
      const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) - o.column.w; // clear span between column faces
      const size = s.axis === 'x' ? [r(len, 3), h, w] : [w, h, r(len, 3)];
      elements.push({
        id: `${o.prefix}-${codePrefix}${seq(i + 1)}`,
        code: `${codePrefix}-${pad(i + 1)}`,
        type: 'beam',
        buildingId: o.buildingId,
        levelId,
        geometry: { shape: 'box', position: [(s.a[0] + s.b[0]) / 2, r(centerY, 3), (s.a[1] + s.b[1]) / 2], size },
        plannedQuantities: qty(w * h * len, (2 * h + w) * len, 150),
      });
    });
  };

  if (o.plinthBeam) addBeams('PB', 'GF', 0, o.plinthBeam);
  addBeams('B', 'RF', o.roofTop - o.beam.h / 2, o.beam);

  const sx = o.xs[o.xs.length - 1] - o.xs[0] + o.column.w + 2 * o.slab.overhang;
  const sz = o.zs[o.zs.length - 1] - o.zs[0] + o.column.d + 2 * o.slab.overhang;
  const t = o.slab.t;
  const slab = {
    id: `${o.prefix}-S001`,
    code: 'SL-01',
    type: 'slab',
    buildingId: o.buildingId,
    levelId: 'RF',
    geometry: {
      shape: 'box',
      position: [(o.xs[0] + o.xs[o.xs.length - 1]) / 2, r(o.roofTop + t / 2, 4), (o.zs[0] + o.zs[o.zs.length - 1]) / 2],
      size: [r(sx, 3), t, r(sz, 3)],
    },
    plannedQuantities: qty(sx * sz * t, sx * sz + 2 * (sx + sz) * t, 90),
  };
  if (o.slabReinforcementPending) {
    delete slab.plannedQuantities.REINF;
    slab.notes = 'Reinforcement quantity awaiting bar bending schedule (BBS) — intentionally not configured in this sample.';
  }
  elements.push(slab);

  return {
    format: 'pmc-procedural-model',
    formatVersion: 1,
    project: o.project,
    model: {
      id: o.modelId,
      name: o.modelName,
      revision: 'R01',
      lengthUnit: 'm',
      upAxis: 'y',
      source: {
        type: 'procedural',
        generator: 'scripts/generate-samples.mjs',
        disclaimer: 'Conceptual demonstration model — not an engineering-approved design. Quantities are illustrative.',
      },
    },
    buildings: [{ id: o.buildingId, name: o.buildingName }],
    levels: [
      { id: 'FDN', name: 'Foundation', buildingId: o.buildingId, elevation: -1.0 },
      { id: 'GF', name: 'Ground Floor', buildingId: o.buildingId, elevation: 0 },
      { id: 'RF', name: 'Roof', buildingId: o.buildingId, elevation: o.roofTop },
    ],
    activities: [
      { code: 'REINF', name: 'Reinforcement', unit: 'kg' },
      { code: 'SHUT', name: 'Shuttering', unit: 'm2' },
      { code: 'CONC', name: 'Concreting', unit: 'm3' },
    ],
    elements,
  };
}

const a = cabin({
  project: { id: 'PMC-SEC-001', name: 'Security Cabin A', location: 'Main Gate (demo site)', client: 'Demo Owner' },
  modelId: 'SEC-CABIN-A',
  modelName: 'Security Cabin A — Structure',
  prefix: 'SCA',
  buildingId: 'BLD-SCA',
  buildingName: 'Security Cabin A',
  xs: [-1.5, 1.5],
  zs: [-1.5, 1.5],
  roofTop: 3.0,
  footing: { w: 1.2, d: 1.2, h: 0.4 },
  column: { w: 0.23, d: 0.23 },
  beam: { w: 0.23, h: 0.45 },
  slab: { t: 0.12, overhang: 0.3 },
});

const b = cabin({
  project: { id: 'PMC-SEC-002', name: 'Security Cabin B', location: 'Service Gate (demo site)', client: 'Demo Owner' },
  modelId: 'SEC-CABIN-B',
  modelName: 'Security Cabin B — Structure',
  prefix: 'SCB',
  buildingId: 'BLD-SCB',
  buildingName: 'Security Cabin B',
  xs: [-2.25, 0, 2.25],
  zs: [-1.6, 1.6],
  roofTop: 3.2,
  footing: { w: 1.4, d: 1.4, h: 0.45 },
  column: { w: 0.3, d: 0.3 },
  beam: { w: 0.3, h: 0.45 },
  plinthBeam: { w: 0.23, h: 0.3 },
  slab: { t: 0.125, overhang: 0.45 },
  slabReinforcementPending: true,
});

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'samples');
writeFileSync(join(out, 'security-cabin-a.json'), JSON.stringify(a, null, 2) + '\n');
writeFileSync(join(out, 'security-cabin-b.json'), JSON.stringify(b, null, 2) + '\n');
console.log(`Cabin A: ${a.elements.length} elements; Cabin B: ${b.elements.length} elements`);

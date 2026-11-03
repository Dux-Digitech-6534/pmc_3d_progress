// The 3D + BOQ Excel workbook (src/assets/PMC-3D-BOQ-Template.xlsx: Project, Levels, Elements, BBS, Openings)
// turned into the model JSON the upload already validates and stores. Each element is a box: plan
// centre X / Y, bottom level, length (X) × width (Y) × height. Element Code is its stable id.

import type { CellValue, WorkbookValues } from '../data/xlsxReader';

export type ExcelModelResult = { ok: true; text: string } | { ok: false; errors: string[] };

const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Quantity columns of the Elements sheet → activity. */
const ACTIVITIES = [
  { col: 'concretem3', code: 'CONC', name: 'Concreting', unit: 'm3' },
  { col: 'steelkg', code: 'REINF', name: 'Reinforcement', unit: 'kg' },
  { col: 'shutteringm2', code: 'SHUT', name: 'Shuttering', unit: 'm2' },
  { col: 'brickworkm3', code: 'BRICK', name: 'Brickwork', unit: 'm3' },
  { col: 'plasterm2', code: 'PLAST', name: 'Plaster', unit: 'm2' },
  { col: 'fixingnos', code: 'FIX', name: 'Fixing', unit: 'nos' },
] as const;

interface Table {
  sheet: string;
  /** Excel row number of each data row (for messages). */
  rowNo: number[];
  rows: Record<string, CellValue>[];
}

export function workbookToModel(book: WorkbookValues): ExcelModelResult {
  const errors: string[] = [];
  const sheetNamed = (name: string) => Object.keys(book).find((k) => norm(k) === norm(name));

  /** Rows of a sheet as {normalised header: value}; the header row is the first row holding `firstHeader`. */
  const table = (name: string, firstHeader: string, required: string[], optional = false): Table | null => {
    const key = sheetNamed(name);
    if (!key) {
      if (!optional) errors.push(`Sheet "${name}" is missing.`);
      return null;
    }
    const grid = book[key];
    const h = grid.findIndex((r) => r?.some((c) => norm(c) === norm(firstHeader)));
    if (h < 0) {
      errors.push(`Sheet "${key}": header row with "${firstHeader}" not found.`);
      return null;
    }
    const heads = grid[h].map(norm);
    const missing = required.filter((c) => !heads.includes(norm(c)));
    if (missing.length) {
      errors.push(`Sheet "${key}": column${missing.length > 1 ? 's' : ''} ${missing.map((c) => `"${c}"`).join(', ')} missing.`);
      return null;
    }
    const t: Table = { sheet: key, rowNo: [], rows: [] };
    grid.slice(h + 1).forEach((r, i) => {
      if (!r?.some((c) => c !== null && String(c).trim() !== '')) return;
      const o: Record<string, CellValue> = {};
      heads.forEach((k, j) => k && (o[k] = r[j] ?? null));
      t.rows.push(o);
      t.rowNo.push(h + i + 2);
    });
    return t;
  };

  const str = (v: CellValue) => (v === null ? '' : String(v).trim());
  /** A number cell; '' when blank; NaN (reported) when not a number. */
  const num = (t: Table, i: number, col: string, label: string, blankOk: boolean): number | null => {
    const v = t.rows[i][norm(col)];
    if (v === null || str(v) === '') {
      if (!blankOk) errors.push(`${t.sheet} row ${t.rowNo[i]}: ${label} — "${col}" is empty.`);
      return null;
    }
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) {
      errors.push(`${t.sheet} row ${t.rowNo[i]}: ${label} — "${col}" is "${v}", not a number.`);
      return null;
    }
    return n;
  };

  const project = table('Project', 'Field', ['Field', 'Value']);
  const levels = table('Levels', 'Level ID', ['Level ID', 'Level Name', 'Building', 'Elevation (m)']);
  const elements = table('Elements', 'Element Code', [
    'Element Code',
    'Type',
    'Level ID',
    'X (m)',
    'Y (m)',
    'Bottom (m)',
    'Length (m)',
    'Width (m)',
    'Height (m)',
  ]);
  const bbs = table('BBS', 'Element Code', ['Element Code', 'Bar Dia (mm)', 'Steel (kg)'], true);
  const openings = table('Openings', 'Wall Code', ['Wall Code', 'Offset (m)', 'Sill (m)', 'Width (m)', 'Height (m)'], true);
  if (!project || !levels || !elements) return { ok: false, errors };

  const field = new Map(project.rows.map((r) => [norm(r.field), str(r.value)]));
  const projectId = field.get('projectid') ?? '';
  if (!projectId) errors.push('Project sheet: "Project ID" is empty.');
  const unit = field.get('lengthunit');
  if (unit && unit.toLowerCase() !== 'm') errors.push(`Project sheet: Length Unit is "${unit}" — sizes and positions must be in metres (m).`);

  // buildings come from the Levels sheet
  const buildings = new Map<string, string>();
  const levelBuilding = new Map<string, string>();
  const levelList = levels.rows.map((r, i) => {
    const bName = str(r.building) || 'Building';
    const bId = `BLD-${bName.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || '1'}`;
    buildings.set(bId, bName);
    const id = str(r.levelid);
    levelBuilding.set(id, bId);
    return { id, name: str(r.levelname) || id, buildingId: bId, elevation: num(levels, i, 'Elevation (m)', `level ${id}`, false) ?? 0 };
  });

  const steel = new Map<string, Record<string, number>>();
  bbs?.rows.forEach((r, i) => {
    const code = str(r.elementcode);
    const dia = num(bbs, i, 'Bar Dia (mm)', code, false);
    const kg = num(bbs, i, 'Steel (kg)', code, false);
    if (!code || dia === null || kg === null) return;
    const m = steel.get(code) ?? {};
    m[String(dia)] = Math.round(((m[String(dia)] ?? 0) + kg) * 1000) / 1000;
    steel.set(code, m);
  });

  const holes = new Map<string, { center: number; bottom: number; width: number; height: number }[]>();
  openings?.rows.forEach((r, i) => {
    const code = str(r.wallcode);
    const o = {
      center: num(openings, i, 'Offset (m)', code, true) ?? 0,
      bottom: num(openings, i, 'Sill (m)', code, true) ?? 0,
      width: num(openings, i, 'Width (m)', code, false),
      height: num(openings, i, 'Height (m)', code, false),
    };
    if (code && o.width !== null && o.height !== null) holes.set(code, [...(holes.get(code) ?? []), o as { center: number; bottom: number; width: number; height: number }]);
  });

  const usedBy = new Map<string, Set<string>>();
  const out = elements.rows.map((r, i) => {
    const code = str(r.elementcode);
    const type = str(r.type).toLowerCase();
    const label = code || `row ${elements.rowNo[i]}`;
    if (!code) errors.push(`Elements row ${elements.rowNo[i]}: "Element Code" is empty.`);
    const g = (c: string) => num(elements, i, c, label, false) ?? 0;
    const [x, y, bottom, l, w, h] = ['X (m)', 'Y (m)', 'Bottom (m)', 'Length (m)', 'Width (m)', 'Height (m)'].map(g);
    const planned: Record<string, { quantity: number; unit: string }> = {};
    for (const a of ACTIVITIES) {
      if (!(a.col in r)) continue;
      const q = num(elements, i, a.col, label, true);
      if (q === null) continue;
      planned[a.code] = { quantity: q, unit: a.unit };
      (usedBy.get(a.code) ?? usedBy.set(a.code, new Set()).get(a.code)!).add(type);
    }
    const wallHoles = holes.get(code);
    holes.delete(code);
    if (wallHoles && type !== 'wall') errors.push(`Openings: "${code}" is a ${type || 'element without type'}, not a wall.`);
    const grade = str(r.concretegrade);
    const notes = str(r.notes);
    return {
      id: code,
      code,
      type,
      buildingId: levelBuilding.get(str(r.levelid)) ?? [...buildings.keys()][0] ?? 'BLD-1',
      levelId: str(r.levelid),
      geometry: {
        shape: type === 'wall' ? 'wall' : 'box',
        position: [x, Math.round((bottom + h / 2) * 10000) / 10000, y],
        size: [l, h, w],
        ...(type === 'wall' && wallHoles ? { openings: wallHoles } : {}),
      },
      plannedQuantities: planned,
      ...(grade ? { concreteGrade: grade.toUpperCase() } : {}),
      ...(steel.has(code) ? { steelByDia: steel.get(code) } : {}),
      ...(notes ? { notes } : {}),
    };
  });
  const codes = new Set(out.map((e) => e.code));
  for (const code of steel.keys()) if (!codes.has(code)) errors.push(`BBS: element "${code}" is not in the Elements sheet.`);
  for (const code of holes.keys()) if (!codes.has(code)) errors.push(`Openings: wall "${code}" is not in the Elements sheet.`);
  if (!out.length) errors.push('Elements sheet has no elements.');
  if (errors.length) return { ok: false, errors };

  const doc = {
    format: 'pmc-procedural-model',
    formatVersion: 1,
    project: {
      id: projectId,
      name: field.get('projectname') || projectId,
      ...(field.get('location') ? { location: field.get('location') } : {}),
      ...(field.get('client') ? { client: field.get('client') } : {}),
    },
    model: {
      id: projectId,
      name: field.get('modelname') || `${field.get('projectname') || projectId} — Structure`,
      revision: field.get('revision') || 'R01',
      lengthUnit: 'm',
      upAxis: 'y',
      source: { type: 'excel' },
    },
    buildings: [...buildings].map(([id, name]) => ({ id, name })),
    levels: levelList,
    // an activity applies to the element types that have a quantity of it
    activities: ACTIVITIES.filter((a) => usedBy.has(a.code)).map((a) => ({ code: a.code, name: a.name, unit: a.unit, appliesTo: [...usedBy.get(a.code)!] })),
    elements: out,
  };
  return { ok: true, text: JSON.stringify(doc, null, 2) };
}

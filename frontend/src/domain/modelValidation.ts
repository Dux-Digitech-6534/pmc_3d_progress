import {
  ELEMENT_TYPES,
  wallDims,
  SUPPORTED_UNITS,
  type ActivityDef,
  type ModelDocument,
  type Unit,
} from './types';

export interface ModelValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  document?: ModelDocument;
}

const MAX_REPORTED = 60;
const MAX_DIMENSION_M = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parse a JSON string and validate it. Never throws. */
export function parseAndValidateModel(text: string): ModelValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`File is not valid JSON: ${(e as Error).message}`], warnings: [] };
  }
  return validateModelDocument(parsed);
}

/**
 * Validate an untrusted model document against the pmc-procedural-model v1 format.
 * Errors block the import; warnings are shown but do not block it.
 */
export function validateModelDocument(input: unknown): ModelValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (msg: string) => {
    if (errors.length < MAX_REPORTED) errors.push(msg);
  };

  if (!isObj(input)) {
    return { ok: false, errors: ['The model file must contain a JSON object at the top level.'], warnings };
  }

  if (input.format !== 'pmc-procedural-model') {
    err(`"format" must be "pmc-procedural-model" (found ${JSON.stringify(input.format)}).`);
  }
  if (input.formatVersion !== 1) {
    err(`"formatVersion" must be 1 (found ${JSON.stringify(input.formatVersion)}).`);
  }

  // project
  const project = input.project;
  if (!isObj(project)) err('"project" is required and must be an object with "id" and "name".');
  else {
    if (!isStr(project.id)) err('"project.id" is required (e.g. "PMC-SEC-001").');
    if (!isStr(project.name)) err('"project.name" is required.');
  }

  // model
  const model = input.model;
  if (!isObj(model)) err('"model" is required and must be an object.');
  else {
    if (!isStr(model.id)) err('"model.id" is required (e.g. "SEC-CABIN-A").');
    if (!isStr(model.name)) err('"model.name" is required.');
    if (!isStr(model.revision)) err('"model.revision" is required (e.g. "R01").');
    if (model.lengthUnit !== 'm') err(`"model.lengthUnit" must be "m" (found ${JSON.stringify(model.lengthUnit)}).`);
    if (model.upAxis !== undefined && model.upAxis !== 'y') err('"model.upAxis" must be "y" when given.');
  }

  // buildings
  const buildingIds = new Set<string>();
  if (!Array.isArray(input.buildings) || input.buildings.length === 0) {
    err('"buildings" must be a non-empty array.');
  } else {
    input.buildings.forEach((b, i) => {
      if (!isObj(b) || !isStr(b.id) || !isStr(b.name)) return err(`buildings[${i}] needs "id" and "name".`);
      if (buildingIds.has(b.id)) err(`Duplicate building id "${b.id}".`);
      buildingIds.add(b.id);
    });
  }

  // levels
  const levelIds = new Set<string>();
  if (!Array.isArray(input.levels) || input.levels.length === 0) {
    err('"levels" must be a non-empty array.');
  } else {
    input.levels.forEach((l, i) => {
      if (!isObj(l) || !isStr(l.id) || !isStr(l.name) || !isStr(l.buildingId)) {
        return err(`levels[${i}] needs "id", "name" and "buildingId".`);
      }
      if (levelIds.has(l.id)) err(`Duplicate level id "${l.id}".`);
      if (!buildingIds.has(l.buildingId)) err(`levels[${i}] ("${l.id}") refers to unknown building "${l.buildingId}".`);
      if (l.elevation !== undefined && !isNum(l.elevation)) err(`levels[${i}].elevation must be a number.`);
      levelIds.add(l.id);
    });
  }

  // activities
  const activities = new Map<string, ActivityDef>();
  if (!Array.isArray(input.activities) || input.activities.length === 0) {
    err('"activities" must be a non-empty array (e.g. Reinforcement/kg, Shuttering/m2, Concreting/m3).');
  } else {
    input.activities.forEach((a, i) => {
      if (!isObj(a) || !isStr(a.code) || !isStr(a.name)) return err(`activities[${i}] needs "code", "name" and "unit".`);
      if (!SUPPORTED_UNITS.includes(a.unit as Unit)) {
        return err(`activities[${i}] ("${a.code}") has unsupported unit ${JSON.stringify(a.unit)}. Supported: ${SUPPORTED_UNITS.join(', ')}.`);
      }
      if (activities.has(a.code)) err(`Duplicate activity code "${a.code}".`);
      if (a.appliesTo !== undefined && (!Array.isArray(a.appliesTo) || !a.appliesTo.every((t: unknown) => ELEMENT_TYPES.includes(t as never)))) {
        err(`activities[${i}] ("${a.code}"): "appliesTo" must be a list of element types (${ELEMENT_TYPES.join(', ')}).`);
      }
      activities.set(a.code, { code: a.code, name: a.name, unit: a.unit as Unit, appliesTo: a.appliesTo as ActivityDef['appliesTo'] });
    });
  }

  // elements
  if (!Array.isArray(input.elements) || input.elements.length === 0) {
    err('"elements" must be a non-empty array.');
  } else {
    const ids = new Set<string>();
    const codes = new Map<string, number>();
    input.elements.forEach((e, i) => {
      if (!isObj(e)) return err(`elements[${i}] must be an object.`);
      const label = isStr(e.id) ? `Element "${e.id}"` : `elements[${i}]`;

      if (!isStr(e.id)) err(`elements[${i}] is missing its stable "id".`);
      else if (ids.has(e.id)) err(`${label}: duplicate stable element id — every element id must be unique within the model.`);
      else ids.add(e.id);

      if (!isStr(e.code)) err(`${label}: "code" (display code such as C-01) is required.`);
      else codes.set(e.code, (codes.get(e.code) ?? 0) + 1);

      if (!ELEMENT_TYPES.includes(e.type as never)) {
        err(`${label}: unsupported type ${JSON.stringify(e.type)}. Supported: ${ELEMENT_TYPES.join(', ')}.`);
      }
      if (!isStr(e.buildingId) || !buildingIds.has(e.buildingId)) err(`${label}: "buildingId" is missing or unknown.`);
      if (!isStr(e.levelId) || !levelIds.has(e.levelId)) err(`${label}: "levelId" is missing or unknown.`);

      const g = e.geometry;
      if (!isObj(g)) err(`${label}: "geometry" is required.`);
      else {
        if (g.shape !== 'box' && g.shape !== 'wall' && g.shape !== 'stair') err(`${label}: geometry.shape must be "box", "wall" or "stair" (found ${JSON.stringify(g.shape)}).`);
        if (g.shape === 'stair') {
          if (!Number.isInteger(g.steps) || (g.steps as number) < 1 || (g.steps as number) > 100) err(`${label}: geometry.steps must be a whole number from 1 to 100.`);
          if (!['+x', '-x', '+z', '-z'].includes(g.up as string)) err(`${label}: geometry.up must be "+x", "-x", "+z" or "-z".`);
          if (!isNum(g.waist) || (g.waist as number) <= 0) err(`${label}: geometry.waist must be a positive number (m).`);
        }
        if (!Array.isArray(g.position) || g.position.length !== 3 || !g.position.every(isNum)) {
          err(`${label}: geometry.position must be three finite numbers [x, y, z].`);
        }
        if (!Array.isArray(g.size) || g.size.length !== 3 || !g.size.every(isNum)) {
          err(`${label}: geometry.size must be three finite numbers [width, height, depth].`);
        } else if (!g.size.every((n: number) => n > 0 && n <= MAX_DIMENSION_M)) {
          err(`${label}: geometry.size values must be greater than 0 and at most ${MAX_DIMENSION_M} m (found ${JSON.stringify(g.size)}).`);
        } else if (g.shape === 'wall') {
          validateOpenings(g.size as [number, number, number], g.openings, label, err);
        } else if (g.openings !== undefined) {
          err(`${label}: only "wall" geometry can have openings.`);
        }
      }

      const pq = e.plannedQuantities;
      if (!isObj(pq)) err(`${label}: "plannedQuantities" is required (use {} if none are known yet).`);
      else {
        const configured = Object.keys(pq);
        configured.forEach((code) => {
          const act = activities.get(code);
          const q = pq[code];
          if (!act) return err(`${label}: planned quantity for unknown activity "${code}".`);
          if (!isObj(q) || !isNum(q.quantity)) return err(`${label}: planned ${act.name} quantity must be a number.`);
          if (q.quantity < 0) err(`${label}: planned ${act.name} quantity cannot be negative.`);
          if (q.unit !== act.unit) {
            err(`${label}: planned ${act.name} unit is ${JSON.stringify(q.unit)} but the activity is measured in "${act.unit}".`);
          }
        });
        const applies = (c: string) => !activities.get(c)?.appliesTo || activities.get(c)!.appliesTo!.includes(e.type as never);
        configured.forEach((c) => {
          if (activities.has(c) && !applies(c)) err(`${label}: planned ${activities.get(c)!.name} quantity, but that activity does not apply to type "${e.type}".`);
        });
        const sbd = e.steelByDia;
        if (sbd !== undefined) {
          if (!isObj(sbd)) err(`${label}: "steelByDia" must be an object of bar diameter (mm) → kg, e.g. { "8": 12.5, "16": 30 }.`);
          else {
            Object.entries(sbd).forEach(([dia, kg]) => {
              if (!/^\d+$/.test(dia) || Number(dia) < 6 || Number(dia) > 40) err(`${label}: steelByDia bar diameter "${dia}" must be a whole number of mm from 6 to 40.`);
              if (!isNum(kg) || kg < 0) err(`${label}: steelByDia["${dia}"] must be a number of kg, 0 or more.`);
            });
            const total = Object.values(sbd).reduce((a: number, kg) => a + (isNum(kg) ? kg : 0), 0);
            const reinf = isObj(pq.REINF) && isNum(pq.REINF.quantity) ? pq.REINF.quantity : null;
            if (reinf !== null && Math.abs(total - reinf) > Math.max(0.5, reinf * 0.01)) {
              warnings.push(`Element "${e.id}": steelByDia adds up to ${Math.round(total * 10) / 10} kg but planned reinforcement is ${reinf} kg — the bar sizes are used as proportions.`);
            }
          }
        }
        if (e.concreteGrade !== undefined && (!isStr(e.concreteGrade) || e.concreteGrade.length > 20)) err(`${label}: "concreteGrade" must be a short text such as "M25".`);
        const missing = [...activities.keys()].filter((c) => applies(c) && (!configured.includes(c) || (isObj(pq[c]) && pq[c].quantity === 0)));
        if (missing.length && isStr(e.id)) {
          warnings.push(`Element "${e.id}" has no planned quantity for ${missing.map((c) => activities.get(c)?.name ?? c).join(', ')} — shown as "Not configured".`);
        }
      }
    });
    codes.forEach((count, code) => {
      if (count > 1) warnings.push(`Display code "${code}" is used by ${count} elements. Codes are labels only; stable ids stay unique.`);
    });
  }

  if (errors.length >= MAX_REPORTED) errors.push('…further errors not shown. Fix the ones above and re-import.');

  return errors.length
    ? { ok: false, errors, warnings }
    : { ok: true, errors, warnings, document: input as unknown as ModelDocument };
}

/** Openings must be positive rectangles that lie fully inside the wall face and do not overlap. */
function validateOpenings(size: [number, number, number], openings: unknown, label: string, err: (m: string) => void) {
  if (openings === undefined) return;
  if (!Array.isArray(openings)) return err(`${label}: geometry.openings must be a list.`);
  const { length, height } = wallDims({ size });
  const ok: { a: number; b: number; lo: number; hi: number }[] = [];
  openings.forEach((o, i) => {
    const at = `${label}: opening ${i + 1}`;
    if (!isObj(o) || ![o.center, o.bottom, o.width, o.height].every(isNum)) return err(`${at} needs numeric center, bottom, width and height.`);
    const [c, b, w, h] = [o.center, o.bottom, o.width, o.height] as number[];
    if (w <= 0 || h <= 0 || b < 0) return err(`${at}: width and height must be > 0 and bottom ≥ 0.`);
    const EPS = 1e-6;
    if (c - w / 2 < -length / 2 - EPS || c + w / 2 > length / 2 + EPS || b + h > height + EPS) {
      return err(`${at} (${w} × ${h} m) does not fit inside the ${length.toFixed(3)} × ${height.toFixed(3)} m wall.`);
    }
    const r = { a: c - w / 2, b: c + w / 2, lo: b, hi: b + h };
    if (ok.some((q) => r.a < q.b - EPS && q.a < r.b - EPS && r.lo < q.hi - EPS && q.lo < r.hi - EPS)) err(`${at} overlaps another opening.`);
    ok.push(r);
  });
}

// Material variation: what the ERP says was sent to the site against what the approved work done
// should have used. Site steel always laps more than the drawing, so a few % over is normal; a big
// difference is a question for the site ("300 kg should have gone in — where did 500 kg go?").

import type { MaterialRequired } from './materialRequired';
import type { MaterialNorms } from './materials';
import { roundQty } from './progress';

/** One item line of an ERP document that sent material to the project. */
export interface SentLine {
  voucher: string;
  date: string;
  itemCode: string;
  itemName: string;
  /** Quantity in the item's stock unit. */
  qty: number;
  uom: string;
}

export type MaterialKind = 'steel' | 'cement' | 'sand' | 'aggregate' | 'concrete' | 'bricks';

export interface ItemMatch {
  kind: MaterialKind;
  /** Bar diameter, mm (steel); 0 = not in the name. */
  dia?: number;
  /** "M25" (ready-mix concrete). */
  grade?: string;
}

/** Report unit of each kind. */
export const KIND_UNITS: Record<MaterialKind, string> = { steel: 'kg', cement: 'bags', sand: 'm³', aggregate: 'm³', concrete: 'm³', bricks: 'nos' };
const KIND_LABELS: Record<MaterialKind, string> = {
  steel: 'Steel',
  cement: 'Cement',
  sand: 'Sand',
  aggregate: 'Aggregate (gitti)',
  concrete: 'Ready-mix concrete',
  bricks: 'Bricks',
};

/** Which material an ERP item is, from its name or code (TMT 12 mm, OPC cement, RMC M25 …); null when not a building material. */
export function matchItem(name: string, code = ''): ItemMatch | null {
  const t = `${name} ${code}`.toLowerCase();
  if (/\b(rmc|ready[\s-]?mix|concrete)\b/.test(t)) {
    const g = /\bm\s?-?(\d{2})\b/.exec(t);
    return { kind: 'concrete', grade: g ? `M${g[1]}` : undefined };
  }
  if (/\b(tmt|rebar|sariya|saria|reinforcement)\b|\bsteel\b.*\bbar|\bfe\s?-?5\d\d/.test(t)) {
    const d = /(\d{1,2})\s?mm\b/.exec(t) ?? /\b(8|10|12|16|20|25|28|32)\s?(?:dia|ø)/.exec(t);
    return { kind: 'steel', dia: d ? Number(d[1]) : 0 };
  }
  if (/\b(cement|opc|ppc)\b/.test(t)) return { kind: 'cement' };
  // "metal" alone is also sheet metal (PEB): only "20 mm metal" / "metal 20mm" is aggregate
  if (/\b(aggregate|gitti|grit|kapchi)\b|\d{1,2}\s?mm\s+metal\b|\bmetal\s+\d{1,2}\s?mm/.test(t)) return { kind: 'aggregate' };
  if (/\b(sand|reti|ret)\b/.test(t)) return { kind: 'sand' };
  if (/\b(brick|bricks|eent|int)\b/.test(t)) return { kind: 'bricks' };
  return null;
}

/** Quantity in the report unit of the kind, or null when the stock unit cannot be converted (e.g. sand in kg). */
export function toReportUnit(kind: MaterialKind, qty: number, uom: string, bagKg: number): number | null {
  const u = uom.trim().toLowerCase().replace(/[\s.]/g, '');
  const tonne = ['ton', 'tons', 'tonne', 'tonnes', 'mt', 't'].includes(u);
  const kg = ['kg', 'kgs', 'kilogram', 'kilograms'].includes(u);
  const m3 = ['m3', 'm³', 'cum', 'cubicmeter', 'cubicmetre', 'cbm'].includes(u);
  const cft = ['cft', 'cuft', 'cubicfeet', 'cubicfoot'].includes(u);
  switch (kind) {
    case 'steel':
      return kg ? qty : tonne ? qty * 1000 : u === 'quintal' ? qty * 100 : null;
    case 'cement':
      return ['bag', 'bags', 'nos', 'no'].includes(u) ? qty : kg ? qty / bagKg : tonne ? (qty * 1000) / bagKg : null;
    case 'sand':
    case 'aggregate':
    case 'concrete':
      return m3 ? qty : cft ? qty * 0.0283168 : u === 'brass' ? qty * 2.83168 : null;
    case 'bricks':
      return ['nos', 'no', 'pcs', 'piece', 'pieces', 'unit', 'units'].includes(u) ? qty : u === 'thousand' || u === '1000nos' ? qty * 1000 : null;
  }
}

export type VariationStatus = 'ok' | 'excess' | 'short' | 'no-work' | 'not-sent';

export interface VariationRow {
  key: string;
  label: string;
  unit: string;
  /** A sub-row (one bar size, one grade) under its material. */
  sub: boolean;
  sent: number;
  needed: number;
  difference: number;
  /** (sent − needed) ÷ needed × 100; null when nothing was needed. */
  percent: number | null;
  status: VariationStatus;
}

export interface VariationReport {
  rows: VariationRow[];
  /** ERP lines that are not a building material this report knows (by item). */
  unmatched: { itemCode: string; itemName: string; qty: number; uom: string }[];
  /** Matched lines whose unit cannot be turned into the report unit. */
  unconvertible: { itemCode: string; itemName: string; qty: number; uom: string; unit: string }[];
}

/**
 * Sent (ERP) against needed (approved work, with the model's norms) per material, steel also per
 * bar size and ready-mix concrete per grade. Within ±tolerance % is OK.
 */
export function variationReport(
  lines: SentLine[],
  needed: MaterialRequired,
  norms: MaterialNorms,
  tolerancePct: number,
  /** Items set by hand (item code → material, or 'ignore'); they win over the name match. */
  itemMap: Record<string, ItemMatch | 'ignore'> = {},
): VariationReport {
  const bagKg = norms.bagKg;
  const sent = new Map<string, number>();
  const add = (k: string, q: number) => sent.set(k, (sent.get(k) ?? 0) + q);
  const unmatched = new Map<string, { itemCode: string; itemName: string; qty: number; uom: string }>();
  const unconvertible = new Map<string, { itemCode: string; itemName: string; qty: number; uom: string; unit: string }>();
  for (const l of lines) {
    const set = itemMap[l.itemCode];
    if (set === 'ignore') continue;
    const m = set ?? matchItem(l.itemName, l.itemCode);
    if (!m) {
      const u = unmatched.get(l.itemCode) ?? { itemCode: l.itemCode, itemName: l.itemName, qty: 0, uom: l.uom };
      u.qty += l.qty;
      unmatched.set(l.itemCode, u);
      continue;
    }
    const q = toReportUnit(m.kind, l.qty, l.uom, bagKg);
    if (q === null) {
      const u = unconvertible.get(l.itemCode) ?? { itemCode: l.itemCode, itemName: l.itemName, qty: 0, uom: l.uom, unit: KIND_UNITS[m.kind] };
      u.qty += l.qty;
      unconvertible.set(l.itemCode, u);
      continue;
    }
    add(m.kind, q);
    if (m.kind === 'steel') add(`steel:${m.dia ?? 0}`, q);
    if (m.kind === 'concrete') add(`concrete:${m.grade ?? '?'}`, q);
  }

  const row = (key: string, label: string, unit: string, s: number, n: number, sub = false): VariationRow => {
    const sentQ = roundQty(s, 2);
    const neededQ = roundQty(n, 2);
    const difference = roundQty(sentQ - neededQ, 2);
    const percent = neededQ > 0 ? roundQty((difference / neededQ) * 100, 1) : null;
    const status: VariationStatus =
      neededQ <= 0 ? (sentQ > 0 ? 'no-work' : 'ok') : sentQ <= 0 ? 'not-sent' : Math.abs(percent!) <= tolerancePct ? 'ok' : percent! > 0 ? 'excess' : 'short';
    return { key, label, unit, sub, sent: sentQ, needed: neededQ, difference, percent, status };
  };

  const rows: VariationRow[] = [];
  // steel, then each bar size that was sent or needed
  const steelNeeded = new Map(needed.steel.map((s) => [s.dia, s.kg]));
  const dias = [...new Set([...steelNeeded.keys(), ...[...sent.keys()].filter((k) => k.startsWith('steel:')).map((k) => Number(k.slice(6)))])].sort(
    (a, b) => (a || 999) - (b || 999),
  );
  if (sent.has('steel') || needed.steelTotal > 0) {
    rows.push(row('steel', KIND_LABELS.steel, 'kg', sent.get('steel') ?? 0, needed.steelTotal));
    for (const d of dias) rows.push(row(`steel:${d}`, d ? `${d} mm` : 'Size not given', 'kg', sent.get(`steel:${d}`) ?? 0, steelNeeded.get(d) ?? 0, true));
  }
  // with ready-mix received, the concrete does not need site cement, sand and gitti
  const rmc = sent.has('concrete') ? needed.concrete.reduce((a, c) => a + c.m3, 0) : 0;
  const simple: [MaterialKind, number][] = [
    ['cement', Math.max(needed.materials.cement - (rmc * norms.concrete.cementKg) / bagKg, 0)],
    ['sand', Math.max(needed.materials.sand - rmc * norms.concrete.sandM3, 0)],
    ['aggregate', Math.max(needed.materials.aggregate - rmc * norms.concrete.aggregateM3, 0)],
    ['bricks', needed.materials.bricks],
  ];
  for (const [k, n] of simple) if (sent.has(k) || n > 0) rows.push(row(k, KIND_LABELS[k], KIND_UNITS[k], sent.get(k) ?? 0, n));
  // ready-mix: only when some was received — otherwise the concrete is mixed on site (cement, sand, gitti above)
  if (sent.has('concrete')) {
    const byGrade = new Map(needed.concrete.map((c) => [c.grade, c.m3]));
    rows.push(row('concrete', KIND_LABELS.concrete, 'm³', sent.get('concrete') ?? 0, needed.concrete.reduce((a, c) => a + c.m3, 0)));
    const grades = [...new Set([...byGrade.keys(), ...[...sent.keys()].filter((k) => k.startsWith('concrete:')).map((k) => k.slice(9))])];
    for (const g of grades) rows.push(row(`concrete:${g}`, g === '?' ? 'Grade not given' : g, 'm³', sent.get(`concrete:${g}`) ?? 0, byGrade.get(g) ?? 0, true));
  }
  return { rows, unmatched: [...unmatched.values()], unconvertible: [...unconvertible.values()] };
}

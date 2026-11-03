// Reads the cell values of an .xlsx workbook in the browser (and in Node for tests) without a library:
// an .xlsx file is a zip of XML parts. Only values are read — no formulas, styles or dates.

export type CellValue = string | number | boolean | null;
/** Sheet name → rows → cells (row 0 = Excel row 1, column 0 = column A); missing cells are null. */
export type WorkbookValues = Record<string, CellValue[][]>;

export class XlsxError extends Error {}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files of a zip archive, by name (read from its central directory). */
async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('This is not an Excel (.xlsx) file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new XlsxError('The Excel file is damaged.');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, await inflateRaw(raw));
    // other methods do not occur in .xlsx files; such a part is skipped
  }
  return files;
}

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'amp') return '&';
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });

const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

/** The text of every <t> in a fragment, joined (rich-text runs, phonetic text excluded). */
const textOf = (xml: string) =>
  unescapeXml(
    [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''),
  );

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(buf: ArrayBuffer): Promise<WorkbookValues> {
  const files = await unzip(buf);
  const text = (name: string) => {
    const f = files.get(name);
    return f ? new TextDecoder().decode(f) : null;
  };
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new XlsxError('This is not an Excel (.xlsx) workbook.');
  const rels = new Map<string, string>();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  const out: WorkbookValues = {};
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unescapeXml(attr(m[1], 'name') ?? '');
    const path = rels.get(attr(m[1], 'r:id') ?? '');
    const xml = path ? text(path) : null;
    const rows: CellValue[][] = [];
    if (xml) {
      for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], 'r');
        if (!ref) continue;
        const r = Number(/\d+$/.exec(ref)?.[0]) - 1;
        const col = colIndex(ref);
        const type = attr(c[1], 't');
        const body = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: CellValue = null;
        if (type === 's') value = v !== undefined ? (shared[Number(v)] ?? null) : null;
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'str' || type === 'e') value = v !== undefined ? unescapeXml(v) : null;
        else if (type === 'b') value = v === '1';
        else if (v !== undefined && v.trim() !== '') value = Number(v);
        (rows[r] ??= [])[col] = value;
      }
    }
    out[name] = Array.from(rows, (row) => Array.from(row ?? [], (v) => v ?? null));
  }
  return out;
}

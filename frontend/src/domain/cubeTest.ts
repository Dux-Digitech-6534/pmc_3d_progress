// Concrete cube test and slump record (meeting 21-11): when Concreting is marked done, the system gives
// the pour a cube number (CUBE-0001, CUBE-0002 … per project); the site writes it on the cubes. The
// number, the slump and the number of cubes are kept at the start of the entry's remarks, so they show
// in Daily Progress Reports, the history and the Excel exports without a new field on the server.

export const CONCRETE_CODE = 'CONC';

const CUBE_RE = /\bCUBE-(\d{4,})\b/;
const RECORD_RE = /^Cube (CUBE-\d{4,}) · Slump (\d+(?:\.\d+)?) mm · (\d+) cubes?(?: — (.*))?$/s;

export interface CubeRecord {
  cubeNo: string;
  slumpMm: number;
  cubes: number;
}

/** The next cube number of the project: one more than the highest already given. */
export function nextCubeNo(remarks: (string | undefined | null)[]): string {
  let max = 0;
  for (const r of remarks) {
    const m = CUBE_RE.exec(r ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `CUBE-${String(max + 1).padStart(4, '0')}`;
}

/** The remarks of a concreting entry: the cube record first, then what the engineer wrote. */
export function cubeRemarks(rec: CubeRecord, remarks: string): string {
  const head = `Cube ${rec.cubeNo} · Slump ${rec.slumpMm} mm · ${rec.cubes} cube${rec.cubes === 1 ? '' : 's'}`;
  return remarks.trim() ? `${head} — ${remarks.trim()}` : head;
}

/** The cube record in an entry's remarks, or null. */
export function parseCube(remarks: string | undefined | null): (CubeRecord & { rest: string }) | null {
  const m = RECORD_RE.exec((remarks ?? '').trim());
  return m ? { cubeNo: m[1], slumpMm: Number(m[2]), cubes: Number(m[3]), rest: m[4] ?? '' } : null;
}

/** Problems with the cube record, in plain words (empty when fine). */
export function cubeErrors(slump: string, cubes: string): string[] {
  const out: string[] = [];
  const s = Number(slump);
  if (slump.trim() === '') out.push('Enter the slump (mm) of the concrete.');
  else if (!Number.isFinite(s) || s <= 0 || s > 300) out.push('Slump must be between 1 and 300 mm.');
  const c = Number(cubes);
  if (!Number.isInteger(c) || c < 1 || c > 30) out.push('Number of cubes must be a whole number from 1 to 30.');
  return out;
}

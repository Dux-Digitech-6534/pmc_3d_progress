import { describe, expect, it } from 'vitest';
import { cubeErrors, cubeRemarks, nextCubeNo, parseCube } from '../src/domain/cubeTest';

describe('concrete cube number and slump', () => {
  it('gives the next number of the project', () => {
    expect(nextCubeNo([])).toBe('CUBE-0001');
    expect(nextCubeNo(['Cube CUBE-0007 · Slump 75 mm · 3 cubes', 'no cube', null, 'Cube CUBE-0002 · Slump 80 mm · 3 cubes'])).toBe('CUBE-0008');
  });

  it('writes and reads the record in the remarks', () => {
    const r = cubeRemarks({ cubeNo: 'CUBE-0003', slumpMm: 75, cubes: 3 }, ' poured in the evening ');
    expect(r).toBe('Cube CUBE-0003 · Slump 75 mm · 3 cubes — poured in the evening');
    expect(parseCube(r)).toEqual({ cubeNo: 'CUBE-0003', slumpMm: 75, cubes: 3, rest: 'poured in the evening' });
    expect(parseCube(cubeRemarks({ cubeNo: 'CUBE-0010', slumpMm: 100, cubes: 1 }, ''))).toEqual({ cubeNo: 'CUBE-0010', slumpMm: 100, cubes: 1, rest: '' });
    expect(parseCube('100% done')).toBeNull();
  });

  it('needs a slump and a sensible number of cubes', () => {
    expect(cubeErrors('', '3')).toEqual(['Enter the slump (mm) of the concrete.']);
    expect(cubeErrors('75', '3')).toEqual([]);
    expect(cubeErrors('500', '0')).toHaveLength(2);
  });
});

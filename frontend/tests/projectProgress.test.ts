import { describe, expect, it } from 'vitest';
import { projectProgress } from '../src/domain/progress';

const s = (code: string, percent: number | null) => ({ activity: { code, name: code, unit: 'm3' as const }, percent });

describe('project progress % by quantity', () => {
  it('weights each work: concrete 40, steel 25, shuttering 15, brickwork 10, plaster 10', () => {
    const p = projectProgress([s('REINF', 60), s('SHUT', 50), s('CONC', 20), s('BRICK', 0), s('PLAST', 0)]);
    expect(p.percent).toBe(30.5); // 60×.25 + 50×.15 + 20×.4
    expect(p.parts.map((x) => x.share)).toEqual([25, 15, 40, 10, 10]);
  });

  it('scales the weights over the works the project has (RCC only)', () => {
    expect(projectProgress([s('REINF', 60), s('SHUT', 50), s('CONC', 20)]).percent).toBe(38.1); // (15+7.5+8)/0.8 = 38.125
  });

  it('is empty when nothing is planned', () => {
    expect(projectProgress([s('CONC', null)]).percent).toBeNull();
    expect(projectProgress([s('CONC', 100), s('REINF', 100)]).percent).toBe(100);
  });
});

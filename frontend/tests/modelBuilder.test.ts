import { describe, expect, it } from 'vitest';
import { LocalRepository, MemoryStorage } from '../src/data/localRepository';
import { blankSpec, buildModel, defaultSpec, formatSpans, headerErrors, makeLayout, parseSpans, removeElement, resizeLayout, toFreeElements, wallOptions, withDefaults, type BuilderSpec } from '../src/domain/modelBuilder';
import { validateModelDocument } from '../src/domain/modelValidation';
import { computeActivityProgress } from '../src/domain/progress';
import { checkQuantity } from '../src/domain/workflow';
import type { ElementRecord, WallGeometry } from '../src/domain/types';

/** The frame-only cabin (the default). */
const frameOnly = (): BuilderSpec => ({ ...defaultSpec(), openings: [] });
/** The cabin with walls switched on (the typical drawing's walls, door, windows, lintels, chhajjas). */
const withWalls = (): BuilderSpec => ({ ...defaultSpec(), walls: { enabled: true, t: 230, internal: false } });

describe('model builder — structural frame', () => {
  it('builds a valid single-bay cabin with the expected elements and quantities', () => {
    const res = buildModel(frameOnly());
    expect(res.errors).toEqual([]);
    expect(res.summary).toMatchObject({ footings: 4, columns: 4, beams: 8, slabs: 1, walls: 0 });
    expect(validateModelDocument(res.document).ok).toBe(true);

    const f = res.document!.elements.find((e) => e.id === 'SECCABIN-FTG-X1Y1')!;
    // F1 1400 × 1400 × 300 mm = 0.588 m3 concrete, 4 × 1.4 × 0.3 = 1.68 m2 shuttering
    expect(f.plannedQuantities.CONC.quantity).toBe(0.588);
    expect(f.plannedQuantities.SHUT.quantity).toBe(1.68);
    expect(f.geometry.position[1]).toBeCloseTo(-0.85); // bottom at -1.0, 0.3 thick

    const col = res.document!.elements.find((e) => e.id === 'SECCABIN-COL-X2Y2')!;
    expect(col.geometry.size[1]).toBeCloseTo(3.7); // footing top -0.7 up to roof level 3.0

    const beam = res.document!.elements.find((e) => e.id === 'SECCABIN-RB-X1Y1-X2Y1')!;
    expect(beam.geometry.size[0]).toBeCloseTo(3.23 - 0.3); // clear span between column faces
  });

  it('skips empty grid points and connects the remaining columns', () => {
    const spec = { ...frameOnly(), xSpans: [3000, 3000], ySpans: [3000], layout: makeLayout(3, 2, 'C1') };
    spec.layout[1][1] = '';
    const res = buildModel(spec);
    expect(res.errors).toEqual([]);
    expect(res.summary!.columns).toBe(5);
    // row Y2 has X1 and X3 only → one long beam between them
    expect(res.document!.elements.some((e) => e.id === 'SECCABIN-PB-X1Y2-X3Y2')).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/no column/);
  });

  it('centres a beam in the clear span when the two columns differ in size', () => {
    const spec = { ...frameOnly(), columnTypes: [{ code: 'C1', w: 300, d: 300, footing: 'F1' }, { code: 'C2', w: 500, d: 300, footing: 'F1' }] };
    spec.layout = [['C1', 'C2'], ['C1', 'C2']];
    const beam = buildModel(spec).document!.elements.find((e) => e.id === 'SECCABIN-RB-X1Y1-X2Y1')!;
    // grid -1.615 / +1.615; faces at -1.465 and +1.365 → length 2.83, centre -0.05
    expect(beam.geometry.size[0]).toBeCloseTo(2.83);
    expect(beam.geometry.position[0]).toBeCloseTo(-0.05);
  });

  it('reports schedule and grid mistakes instead of building', () => {
    const spec = defaultSpec();
    spec.columnTypes = [{ code: 'C1', w: 300, d: 300, footing: 'F9' }];
    spec.xSpans = [0];
    const res = buildModel(spec);
    expect(res.document).toBeNull();
    expect(res.errors.join(' ')).toMatch(/F9/);
    expect(res.errors.join(' ')).toMatch(/X spacings/);
  });

  it('leaves reinforcement unconfigured when the steel rate is 0', () => {
    const res = buildModel({ ...frameOnly(), steel: { footing: 0, column: 0, beam: 0, slab: 0 } });
    expect(res.document!.elements.every((e) => !e.plannedQuantities.REINF)).toBe(true);
  });

  it('parses spacing text and resizes the layout keeping existing cells', () => {
    expect(parseSpans('3230, 2115')).toEqual([3230, 2115]);
    expect(parseSpans('3230 x')).toBeNull();
    expect(parseSpans('')).toBeNull();
    const l = resizeLayout([['C2', 'C1']], 3, 2, 'C1');
    expect(l).toEqual([['C2', 'C1', 'C1'], ['C1', 'C1', 'C1']]);
  });
});

describe('model builder — walls, openings, lintels, chhajjas', () => {
  const res = buildModel(withWalls());
  const els = res.document!.elements;
  const byId = (id: string) => els.find((e) => e.id === id)!;

  it('builds the default cabin like the typical drawing and it passes model validation', () => {
    expect(res.errors).toEqual([]);
    expect(res.summary).toMatchObject({ walls: 4, doors: 1, windows: 3, lintels: 4, chhajjas: 4 });
    expect(els).toHaveLength(33);
    const v = validateModelDocument(res.document);
    expect(v.errors).toEqual([]);
  });

  it('makes walls between column faces, from plinth top to roof beam soffit, with the openings cut in', () => {
    const wall = byId('SECCABIN-WAL-X1Y1-X2Y1');
    const g = wall.geometry as WallGeometry;
    expect(g.shape).toBe('wall');
    expect(g.size[0]).toBeCloseTo(2.93); // 3230 − 300 column
    expect(g.size[1]).toBeCloseTo(2.7); // roof 3000 − roof beam 300
    expect(g.size[2]).toBeCloseTo(0.23);
    expect(g.position[1]).toBeCloseTo(1.35);
    expect(g.openings).toEqual([{ center: 0, bottom: 0, width: 0.9, height: 2.1 }]);
  });

  it('deducts openings and lintels from brickwork, openings from plaster', () => {
    const wall = byId('SECCABIN-WAL-X1Y1-X2Y1');
    // gross 2.93 × 2.7 = 7.911 m2; door 0.9 × 2.1 = 1.89; lintel (0.9 + 2 × 0.15) × 0.23 × 0.15
    const net = 7.911 - 1.89;
    expect(wall.plannedQuantities.PLAST.quantity).toBeCloseTo(2 * net, 2);
    expect(wall.plannedQuantities.BRICK.quantity).toBeCloseTo(net * 0.23 - 1.2 * 0.23 * 0.15, 3);
    expect(wall.plannedQuantities.CONC).toBeUndefined();
  });

  it('places the lintel on top of the opening and the chhajja outside the wall', () => {
    const lintel = byId('SECCABIN-LNT-X1Y2-X2Y2-1'); // over ventilator V (sill 1800 + 450)
    expect(lintel.geometry.position[1]).toBeCloseTo(2.25 + 0.075);
    expect(lintel.geometry.size[0]).toBeCloseTo(0.9); // 600 + 2 × 150 bearing
    const ch = byId('SECCABIN-CHJ-X1Y1-X2Y1-1'); // over the door on the Y1 wall (the front, +Z, nearest the camera)
    expect(ch.geometry.position[2]).toBeGreaterThan(1.615); // outside the grid line
    expect(ch.geometry.position[2]).toBeCloseTo(1.615 + (0.115 + 0.225));
    expect(byId('SECCABIN-CHJ-X2Y1-X2Y2-1').geometry.position[0]).toBeGreaterThan(1.615); // X2 wall → +x side
  });

  it('marks activities as applicable only to their element types', () => {
    const acts = res.document!.activities;
    const conc = acts.find((a) => a.code === 'CONC')!;
    const brick = acts.find((a) => a.code === 'BRICK')!;
    const wall = { ...byId('SECCABIN-WAL-X1Y1-X2Y1') } as unknown as ElementRecord;
    expect(computeActivityProgress(wall, conc, []).status).toBe('not-applicable');
    expect(computeActivityProgress(wall, brick, []).status).toBe('not-started');
    expect(checkQuantity({ element: wall, activity: conc, quantity: 1, unit: 'm3', entries: [], mode: 'claim' })[0]).toMatch(/does not apply/);
    const door = byId('SECCABIN-OPN-X1Y1-X2Y1-1');
    expect(door.type).toBe('door');
    expect(door.plannedQuantities).toEqual({ FIX: { quantity: 1, unit: 'nos' } });
  });

  it('positions an opening by offset from the wall start and reports misfits and overlaps', () => {
    const spec = withWalls();
    spec.openings = [{ mark: 'W', wall: 'X1Y1-X2Y1', offset: 1000 }];
    const g = buildModel(spec).document!.elements.find((e) => e.id === 'SECCABIN-WAL-X1Y1-X2Y1')!.geometry as WallGeometry;
    expect(g.openings![0].center).toBeCloseTo(-0.615); // grid start −1.615 + 1.0

    spec.openings = [{ mark: 'W', wall: 'X1Y1-X2Y1', offset: 200 }];
    expect(buildModel(spec).errors.join(' ')).toMatch(/outside the wall/);

    spec.openings = [
      { mark: 'W', wall: 'X1Y1-X2Y1', offset: null },
      { mark: 'D', wall: 'X1Y1-X2Y1', offset: null },
    ];
    expect(buildModel(spec).errors.join(' ')).toMatch(/overlaps/);

    spec.openings = [{ mark: 'Z', wall: 'X9Y9-X1Y1', offset: null }];
    const errs = buildModel(spec).errors.join(' ');
    expect(errs).toMatch(/mark "Z"/);
    expect(errs).toMatch(/does not exist/);
  });

  it('skips the lintel (with a warning) when the opening reaches the roof beam', () => {
    const spec = withWalls();
    spec.openingTypes = [{ mark: 'D', kind: 'door', w: 900, h: 2650, sill: 0 }];
    spec.openings = [{ mark: 'D', wall: 'X1Y1-X2Y1', offset: null }];
    const r = buildModel(spec);
    expect(r.errors).toEqual([]);
    expect(r.summary!.lintels).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/roof beam acts as lintel/);
  });

  it('lists only outer walls unless internal walls are on', () => {
    const spec = { ...withWalls(), xSpans: [3000, 3000], layout: makeLayout(3, 2, 'C1'), openings: [] };
    expect(wallOptions(spec).map((w) => w.key)).toEqual(['X1Y1-X2Y1', 'X2Y1-X3Y1', 'X1Y2-X2Y2', 'X2Y2-X3Y2', 'X1Y1-X1Y2', 'X3Y1-X3Y2']);
    expect(wallOptions({ ...spec, walls: { ...spec.walls, internal: true } }).map((w) => w.key)).toContain('X2Y1-X2Y2');
    expect(buildModel(spec).summary!.walls).toBe(6);
  });

  it('upgrades a saved spec from before walls existed as frame-only, with the openings that fit its grid pre-filled', () => {
    const strip = (s: BuilderSpec) => {
      const old = { ...s } as Partial<BuilderSpec>;
      delete old.walls;
      delete old.openings;
      delete old.openingTypes;
      delete old.lintel;
      delete old.chhajja;
      return old;
    };
    const up = withDefaults(strip(frameOnly()));
    expect(up.walls.enabled).toBe(false);
    expect(up.openings).toHaveLength(4);
    expect(buildModel(up).summary).toMatchObject({ walls: 0, doors: 0, windows: 0, lintels: 0, chhajjas: 0 });
    expect(buildModel({ ...up, walls: { ...up.walls, enabled: true } }).summary).toMatchObject({ walls: 4, doors: 1, windows: 3 });

    // 3 × 2 grid: X2Y1-X2Y2 is internal, so only the placements on outer walls are kept
    const wide = withDefaults(strip({ ...frameOnly(), xSpans: [3000, 3000], layout: makeLayout(3, 2, 'C1') }));
    expect(wide.openings.map((o) => o.wall)).toEqual(['X1Y1-X2Y1', 'X1Y1-X1Y2', 'X1Y2-X2Y2']);
    expect(buildModel(wide).errors).toEqual([]);
  });
});

describe('model builder — import', () => {
  it('imports through the normal pipeline and refuses the same revision twice', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage() });
    const text = JSON.stringify(buildModel(defaultSpec()).document);
    const first = await repo.importModel({ text, sourceName: 'Model Builder', sourceType: 'Model Builder (from drawing)' });
    expect(first.ok).toBe(true);
    expect(first.createdProject).toBe(true);
    expect(first.record!.elementCount).toBe(17); // default = structural frame only
    const again = await repo.importModel({ text, sourceName: 'Model Builder', sourceType: 'Model Builder (from drawing)' });
    expect(again.ok).toBe(false);
    const r02 = JSON.stringify(buildModel({ ...defaultSpec(), revision: 'R02', roofLevel: 3200 }).document);
    const second = await repo.importModel({ text: r02, sourceName: 'Model Builder', sourceType: 'Model Builder (from drawing)' });
    expect(second.ok).toBe(true);
    expect(second.supersededKey).toBeTruthy();
  });

  it('records brickwork progress on a wall and refuses concreting on it', async () => {
    const repo = new LocalRepository({ storage: new MemoryStorage() });
    await repo.importModel({ text: JSON.stringify(buildModel(withWalls()).document), sourceName: 'b', sourceType: 'Model Builder (from drawing)' });
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const base = { projectId: 'PMC-SEC-003', elementId: 'SECCABIN-WAL-X1Y1-X2Y1', date, remarks: '', photos: [] };
    const ok = await repo.saveProgressEntry({ ...base, clientRequestId: 'a', activityCode: 'BRICK', quantity: 0.5, unit: 'm3' }, 'site-engineer');
    expect(ok.status).toBe('Draft');
    await expect(
      repo.saveProgressEntry({ ...base, clientRequestId: 'b', activityCode: 'CONC', quantity: 0.1, unit: 'm3' }, 'site-engineer'),
    ).rejects.toThrow(/does not apply/);
  });
});

describe('model builder — orientation', () => {
  it('puts Y1 in front (+Z) and measures offsets on Y-direction walls from Y1 towards Y2', () => {
    const spec = withWalls();
    spec.openings = [{ mark: 'W', wall: 'X1Y1-X1Y2', offset: 1000 }];
    const els = buildModel(spec).document!.elements;
    expect(els.find((e) => e.id === 'SECCABIN-COL-X1Y1')!.geometry.position[2]).toBeCloseTo(1.615);
    expect(els.find((e) => e.id === 'SECCABIN-COL-X1Y2')!.geometry.position[2]).toBeCloseTo(-1.615);
    const wall = els.find((e) => e.id === 'SECCABIN-WAL-X1Y1-X1Y2')!;
    expect(wall.geometry.size[2]).toBeCloseTo(2.93);
    // opening centre 1.0 m from Y1 (z = 1.615) towards Y2 → z = 0.615; wall centre z = 0
    expect((wall.geometry as WallGeometry).openings![0].center).toBeCloseTo(0.615);
    const win = els.find((e) => e.id === 'SECCABIN-OPN-X1Y1-X1Y2-1')!;
    expect(win.geometry.position[2]).toBeCloseTo(0.615);
  });
});

describe('model builder — opening position range', () => {
  it('gives the centred position and the limits between the column faces', async () => {
    const { openingRange } = await import('../src/domain/modelBuilder');
    const spec = withWalls(); // 3230 grid, 300 columns, door D 900 wide
    // faces at 150 and 3080 → centre 1615; door centre from 150 + 450 = 600 to 3080 − 450 = 2630
    expect(openingRange(spec, { mark: 'D', wall: 'X1Y1-X2Y1' })).toEqual({ centre: 1615, min: 600, max: 2630, fits: true });
    expect(openingRange(spec, { mark: 'W', wall: 'X1Y1-X1Y2' })).toEqual({ centre: 1615, min: 900, max: 2330, fits: true });
    expect(openingRange(spec, { mark: 'D', wall: 'nonsense' })).toBeNull();
    expect(openingRange(spec, { mark: 'Z', wall: 'X1Y1-X2Y1' })).toBeNull();
    // the extremes really build without errors
    for (const offset of [600, 2630]) {
      const s = { ...spec, openings: [{ mark: 'D', wall: 'X1Y1-X2Y1', offset }] };
      expect(buildModel(s).errors).toEqual([]);
    }
    expect(buildModel({ ...spec, openings: [{ mark: 'D', wall: 'X1Y1-X2Y1', offset: 599 }] }).errors.join(' ')).toMatch(/outside the wall/);
  });
});

describe('model builder — opening problems are explained', () => {
  it('says which openings overlap, where, and what to do (the W1 / W2 case from the side wall)', () => {
    const spec = withWalls();
    spec.walls.t = 233;
    spec.openingTypes = [
      { mark: 'W1', kind: 'window', w: 1200, h: 1200, sill: 5 },
      { mark: 'W2', kind: 'door', w: 1000, h: 1980, sill: 25 },
    ];
    spec.openings = [
      { mark: 'W2', wall: 'X1Y1-X1Y2', offset: 2315 },
      { mark: 'W1', wall: 'X1Y1-X1Y2', offset: 1715 },
    ];
    const msg = buildModel(spec).errors.join(' ');
    expect(msg).toContain('Opening row 2 (W1 on wall X1Y1-X1Y2): W1 (1115–2315 mm) overlaps W2 from row 1 (1815–2815 mm) between 1815 and 2315 mm');
    expect(msg).toContain('◀ ▶');
    spec.openings[1].offset = 750; // 150–1350, clear of the door
    expect(buildModel(spec).errors).toEqual([]);
  });

  it('gives the usable position range when an opening runs past a column', () => {
    const spec = withWalls();
    spec.openings = [{ mark: 'D', wall: 'X1Y1-X2Y1', offset: 300 }];
    expect(buildModel(spec).errors.join(' ')).toContain('at position 300 it runs from -150 to 750 mm, outside the wall (150–3080 mm between the column faces). Use a position from 600 to 2630.');
  });
});

describe('model builder — doors start at the floor', () => {
  it('ignores a sill typed for a door', () => {
    const spec = withWalls();
    spec.openingTypes = [{ mark: 'D', kind: 'door', w: 900, h: 2100, sill: 25 }];
    spec.openings = [{ mark: 'D', wall: 'X1Y1-X2Y1', offset: null }];
    const doc = buildModel(spec).document!;
    const wall = doc.elements.find((e) => e.id === 'SECCABIN-WAL-X1Y1-X2Y1')!.geometry as WallGeometry;
    expect(wall.openings![0].bottom).toBe(0);
    expect(doc.elements.find((e) => e.type === 'door')!.geometry.position[1]).toBeCloseTo(1.05);
  });
});

describe('model builder — elements clicked in the 3D preview', () => {
  const refOf = (spec: BuilderSpec, code: string) => {
    const res = buildModel(spec);
    const el = res.document!.elements.find((e) => e.code === code);
    expect(el, code).toBeDefined();
    return res.refs[el!.id];
  };
  const codes = (spec: BuilderSpec) => buildModel(spec).document!.elements.map((e) => e.code);

  it('maps every generated element back to the form', () => {
    const res = buildModel(withWalls());
    expect(res.document!.elements.every((e) => res.refs[e.id])).toBe(true);
    expect(refOf(withWalls(), 'C1-X2Y1')).toEqual({ kind: 'column', xi: 1, yi: 0 });
    expect(refOf(withWalls(), 'D-X1Y1-X2Y1')).toEqual({ kind: 'opening', row: 0 });
  });

  it('removing a column clears its grid point, its footing and the doors / windows in its walls', () => {
    const spec = withWalls();
    const next = removeElement(spec, refOf(spec, 'C1-X2Y1'));
    expect(next.layout[0][1]).toBe('');
    const left = codes(next);
    expect(left).not.toContain('C1-X2Y1');
    expect(left).not.toContain('F1-X2Y1');
    expect(next.openings.some((o) => o.wall.includes('X2Y1'))).toBe(false);
    expect(buildModel(next).errors).toEqual([]);
  });

  it('removes a single beam, wall, lintel or chhajja and can restore it', () => {
    const spec = withWalls();
    let next = removeElement(spec, refOf(spec, 'PB-X1Y1-X2Y1'));
    expect(codes(next)).not.toContain('PB-X1Y1-X2Y1');
    expect(codes(next)).toContain('RB-X1Y1-X2Y1');
    next = removeElement(next, refOf(next, 'L-W-X1Y1-X1Y2'));
    next = removeElement(next, refOf(next, 'CH-W-X1Y1-X1Y2'));
    expect(codes(next)).not.toContain('L-W-X1Y1-X1Y2');
    expect(codes(next)).not.toContain('CH-W-X1Y1-X1Y2');
    expect(codes(next)).toContain('W-X1Y1-X1Y2'); // the window itself stays

    const noWall = removeElement(next, refOf(next, 'W-X1Y1-X2Y1'));
    expect(codes(noWall)).not.toContain('W-X1Y1-X2Y1');
    expect(noWall.openings.some((o) => o.wall === 'X1Y1-X2Y1')).toBe(false); // the door in it went too
    expect(wallOptions(noWall).map((w) => w.key)).not.toContain('X1Y1-X2Y1');
    expect(buildModel(noWall).warnings.some((w) => w.includes('removed by hand'))).toBe(true);

    expect(codes({ ...noWall, omit: [] })).toContain('PB-X1Y1-X2Y1');
  });

  it('removing a door / window drops its placement; removing the slab switches it off', () => {
    const spec = withWalls();
    const next = removeElement(spec, refOf(spec, 'V-X1Y2-X2Y2'));
    expect(next.openings).toHaveLength(spec.openings.length - 1);
    expect(codes(next).some((c) => c.startsWith('V-'))).toBe(false);
    expect(removeElement(spec, refOf(spec, 'SL-RF')).slab.enabled).toBe(false);
  });
});

describe('model builder — planned quantities typed in by hand', () => {
  const footing = (spec: BuilderSpec) => buildModel(spec).document!.elements.find((e) => e.code === 'F1-X1Y1')!;

  it('uses the typed value instead of the calculated one, and keeps the calculated one as "auto"', () => {
    const base = frameOnly();
    const calc = footing(base).plannedQuantities.REINF.quantity;
    const spec = { ...base, qtyOverride: { 'F1-X1Y1': { REINF: 31.5, CONC: 0.6 } } };
    const res = buildModel(spec);
    const el = res.document!.elements.find((e) => e.code === 'F1-X1Y1')!;
    expect(el.plannedQuantities.REINF).toEqual({ quantity: 31.5, unit: 'kg' });
    expect(el.plannedQuantities.CONC.quantity).toBe(0.6);
    expect(res.auto[el.id].REINF).toBe(calc);
    expect(res.summary!.steel).toBeCloseTo(buildModel(base).summary!.steel + 31.5 - calc, 1);
    expect(res.warnings.some((w) => w.includes('entered by hand'))).toBe(true);
    expect(validateModelDocument(res.document).errors).toEqual([]);
  });

  it('adds a quantity the rates left out (steel rate 0) and refuses a bad number', () => {
    const base = { ...frameOnly(), steel: { ...frameOnly().steel, footing: 0 } };
    expect(footing(base).plannedQuantities.REINF).toBeUndefined();
    expect(footing({ ...base, qtyOverride: { 'F1-X1Y1': { REINF: 20 } } }).plannedQuantities.REINF).toEqual({ quantity: 20, unit: 'kg' });
    expect(buildModel({ ...base, qtyOverride: { 'F1-X1Y1': { CONC: NaN } } }).errors[0]).toMatch(/F1-X1Y1: planned Concreting must be a number/);
    // an activity that does not apply to the element is ignored
    expect(footing({ ...base, qtyOverride: { 'F1-X1Y1': { BRICK: 5 } } }).plannedQuantities.BRICK).toBeUndefined();
  });
});

describe('model builder — blank form for a new project', () => {
  it('has no project or model names, so they must be filled before creating', () => {
    const b = blankSpec();
    expect([b.projectId, b.projectName, b.modelId, b.buildingName]).toEqual(['', '', '', '']);
    expect(headerErrors(b)).toHaveLength(4);
    expect(headerErrors(defaultSpec())).toEqual([]);
  });
});

describe('model builder — spacings written short', () => {
  it('reads "3000*40" as 40 spacings and writes runs back the same way', () => {
    expect(parseSpans('3000*3, 2000')).toEqual([3000, 3000, 3000, 2000]);
    expect(parseSpans('2500x2')).toEqual([2500, 2500]);
    expect(parseSpans('3000*0')).toBeNull();
    expect(parseSpans('')).toBeNull();
    expect(parseSpans('', true)).toEqual([]);
    expect(formatSpans([3000, 3000, 3000, 2000, 2000])).toBe('3000*3, 2000, 2000');
  });
});

describe('model builder — boundary wall', () => {
  const wall = (over: Partial<BuilderSpec> = {}): BuilderSpec => ({
    ...defaultSpec(),
    kind: 'boundary',
    xSpans: Array(5).fill(3000),
    ySpans: [],
    layout: makeLayout(6, 1, 'C1'),
    roofLevel: 2100,
    roofBeam: { enabled: true, w: 230, h: 150 },
    walls: { enabled: true, t: 230, internal: false },
    openings: [],
    ...over,
  });

  it('a straight wall: a pier + footing at every point, beams and a panel between neighbours, no slab', () => {
    const res = buildModel(wall());
    expect(res.errors).toEqual([]);
    expect(res.summary).toMatchObject({ footings: 6, columns: 6, beams: 10, walls: 5, slabs: 0, chhajjas: 0 });
    const panel = res.document!.elements.find((e) => e.type === 'wall')!;
    expect(panel.geometry.size[1]).toBeCloseTo(1.95); // 2100 top of wall − 150 coping beam
    expect(validateModelDocument(res.document).errors).toEqual([]);
  });

  it('around a plot: only the outer edge, never a beam or wall across the plot', () => {
    const ring = makeLayout(4, 3, '').map((row, y) => row.map((_, x) => (y === 0 || y === 2 || x === 0 || x === 3 ? 'C1' : '')));
    const res = buildModel(wall({ xSpans: [3000, 3000, 3000], ySpans: [3000, 3000], layout: ring }));
    expect(res.errors).toEqual([]);
    // perimeter of a 3 × 2 bay plot = 10 bays
    expect(res.summary).toMatchObject({ columns: 10, walls: 10, beams: 20, slabs: 0 });
    expect(wallOptions(wall({ xSpans: [3000, 3000, 3000], ySpans: [3000, 3000], layout: ring }))).toHaveLength(10);
  });
});

describe('model builder — free model', () => {
  const free = (): BuilderSpec => ({
    ...defaultSpec(),
    kind: 'free',
    freeElements: [
      { code: 'F1', type: 'footing', x: 0, y: 0, z: -1000, l: 1200, w: 1200, h: 300 },
      { code: 'C1', type: 'column', x: 0, y: 0, z: -700, l: 300, w: 300, h: 3700 },
      { code: 'W1', type: 'wall', x: 1650, y: 0, z: 0, l: 3000, w: 230, h: 2700 },
    ],
  });

  it('builds every listed element with quantities from its own box', () => {
    const res = buildModel(free());
    expect(res.errors).toEqual([]);
    const [f, c, w] = res.document!.elements;
    expect(f.plannedQuantities.CONC.quantity).toBeCloseTo(0.432); // 1.2 × 1.2 × 0.3
    expect(f.plannedQuantities.SHUT.quantity).toBeCloseTo(1.44); // 2 × (1.2 + 1.2) × 0.3
    expect(f.plannedQuantities.REINF.quantity).toBeCloseTo(0.432 * 80, 1);
    expect(c.geometry.position[1]).toBeCloseTo(-0.7 + 3.7 / 2);
    expect(w.plannedQuantities.BRICK.quantity).toBeCloseTo(3 * 0.23 * 2.7, 3);
    expect(w.geometry.shape).toBe('wall');
    expect(res.refs[c.id]).toEqual({ kind: 'free', index: 1 });
    expect(validateModelDocument(res.document).errors).toEqual([]);
  });

  it('explains bad rows and removes a clicked element', () => {
    const bad = { ...free(), freeElements: [...free().freeElements!, { code: 'C1', type: 'column' as const, x: 0, y: 0, z: 0, l: 0, w: 300, h: 3000 }] };
    const errs = buildModel(bad).errors;
    expect(errs.some((e) => e.includes('"C1" is used twice'))).toBe(true);
    expect(errs.some((e) => e.includes('must be positive'))).toBe(true);
    const res = buildModel(free());
    const c = res.document!.elements[1];
    expect(removeElement(free(), res.refs[c.id]).freeElements!.map((e) => e.code)).toEqual(['F1', 'W1']);
  });

  it('a template model becomes the same free model', () => {
    const doc = buildModel({ ...defaultSpec(), openings: [] }).document!;
    const res = buildModel({ ...defaultSpec(), kind: 'free', freeElements: toFreeElements(doc) });
    expect(res.errors).toEqual([]);
    expect(res.summary!.concrete).toBeCloseTo(buildModel({ ...defaultSpec(), openings: [] }).summary!.concrete, 2);
  });
});

describe('model builder — elements added by hand on a template', () => {
  const extra = { code: 'W-N1', type: 'wall' as const, x: 0, y: 3000, z: 0, l: 3000, w: 230, h: 2700 };

  it('adds them to the template model with their own quantities, and removes them again', () => {
    const base = buildModel({ ...defaultSpec(), openings: [] });
    const res = buildModel({ ...defaultSpec(), openings: [], extraElements: [extra] });
    expect(res.errors).toEqual([]);
    expect(res.summary!.walls).toBe(base.summary!.walls + 1);
    const wall = res.document!.elements.find((e) => e.code === 'W-N1')!;
    expect(wall.plannedQuantities.BRICK.quantity).toBeCloseTo(3 * 0.23 * 2.7, 3);
    expect(wall.geometry.position).toEqual([0, 1.35, -3]); // x / y from the model centre; plan Y is −Z in 3D
    expect(res.refs[wall.id]).toEqual({ kind: 'extra', index: 0 });
    expect(validateModelDocument(res.document).errors).toEqual([]);
    const back = removeElement({ ...defaultSpec(), openings: [], extraElements: [extra] }, res.refs[wall.id]);
    expect(back.extraElements).toEqual([]);
  });

  it('refuses a code the template already uses', () => {
    const res = buildModel({ ...defaultSpec(), openings: [], extraElements: [{ ...extra, code: 'C1-X1Y1' }] });
    expect(res.errors[0]).toMatch(/"C1-X1Y1" is used twice/);
  });
});

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { elementGeometry } from '../src/components/ModelViewer';

const box = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  const s = g.boundingBox!.getSize(new THREE.Vector3());
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  return { size: [s.x, s.y, s.z].map((n) => +n.toFixed(4)), centre: [c.x, c.y, c.z].map((n) => +n.toFixed(4) + 0) };
};

/** Signed area of the wall face = triangles facing +Z (front face) only. */
const frontArea = (g: THREE.BufferGeometry) => {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const tri = (i: number) => (idx ? idx.getX(i) : i);
  const n = idx ? idx.count : pos.count;
  let area = 0;
  for (let i = 0; i < n; i += 3) {
    const [a, b, c] = [tri(i), tri(i + 1), tri(i + 2)].map((k) => new THREE.Vector3().fromBufferAttribute(pos, k));
    const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (cross.z > 1e-9 && Math.abs(cross.x) < 1e-9 && Math.abs(cross.y) < 1e-9) area += cross.length() / 2;
  }
  return area;
};

describe('wall geometry', () => {
  it('keeps the wall box size and centre, and removes the opening area from the face', () => {
    const g = elementGeometry({
      shape: 'wall',
      position: [0, 0, 0],
      size: [3, 2.7, 0.23],
      openings: [
        { center: -0.6, bottom: 0, width: 0.9, height: 2.1 }, // door: notch in the outline
        { center: 0.8, bottom: 0.9, width: 1.0, height: 1.2 }, // window: hole
      ],
    });
    expect(box(g)).toEqual({ size: [3, 2.7, 0.23], centre: [0, 0, 0] });
    expect(frontArea(g)).toBeCloseTo(3 * 2.7 - 0.9 * 2.1 - 1.0 * 1.2, 4);
  });

  it('rotates a wall that runs along Z', () => {
    const g = elementGeometry({ shape: 'wall', position: [0, 0, 0], size: [0.23, 2.7, 3], openings: [{ center: 0, bottom: 0.9, width: 1, height: 1 }] });
    expect(box(g).size).toEqual([0.23, 2.7, 3]);
  });

  it('uses a plain box for boxes and walls without openings', () => {
    expect(elementGeometry({ shape: 'box', position: [0, 0, 0], size: [1, 2, 3] })).toBeInstanceOf(THREE.BoxGeometry);
    expect(elementGeometry({ shape: 'wall', position: [0, 0, 0], size: [3, 2, 0.2] })).toBeInstanceOf(THREE.BoxGeometry);
  });
});

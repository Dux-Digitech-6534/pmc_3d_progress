import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { wallDims, type ElementGeometry, type ElementRecord } from '../domain/types';
import { SELECTION_COLOR } from '../lib/colors';

export interface ModelViewerProps {
  elements: ElementRecord[];
  /** Fill colour per element id. */
  colors: Map<string, string>;
  /** Elements passing the current filters. Others are drawn as faint ghosts and are not pickable. */
  visibleIds: Set<string>;
  selectedIds: Set<string>;
  showLabels: boolean;
  /** additive = Ctrl/Cmd held. id is null when empty space was clicked. */
  onPick: (id: string | null, additive: boolean) => void;
  /** Increment to frame the whole model again. */
  resetSignal: number;
  /**
   * The camera is framed to the model only when this key changes (e.g. another model or a different
   * building size). Editing elements keeps the user's camera. Omitted = frame on every element change.
   */
  frameKey?: string;
}

interface ElementObjects {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  label: CSS2DObject;
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root: THREE.Group;
  objects: Map<string, ElementObjects>;
  render: () => void;
}

const EDGE_COLOR = new THREE.Color('#1f2a37');
const SEL = new THREE.Color(SELECTION_COLOR);

/**
 * Procedural Three.js viewer: one mesh per element, identified ONLY by the stable source
 * element id stored in userData (never the Three.js object id). Renders on demand.
 */
export function ModelViewer(props: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const propsRef = useRef(props);
  const framedKey = useRef<string | undefined | null>(null); // null = never framed yet
  propsRef.current = props;
  const [glError, setGlError] = useState<string | null>(null);
  const [hoverCode, setHoverCode] = useState<string | null>(null);

  // --- one-time scene setup ---
  useEffect(() => {
    const host = hostRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (e) {
      setGlError(`3D view unavailable: WebGL could not start (${(e as Error).message}). The element list and forms still work.`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor('#eef2f6');
    renderer.domElement.className = 'viewer-canvas';
    host.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = 'viewer-labels';
    host.appendChild(labelRenderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    camera.position.set(8, 6, 9);

    scene.add(new THREE.HemisphereLight('#ffffff', '#b8c2cc', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(6, 12, 8);
    scene.add(sun);
    const fill = new THREE.DirectionalLight('#ffffff', 0.5);
    fill.position.set(-8, 4, -6);
    scene.add(fill);

    const grid = new THREE.GridHelper(30, 30, '#9fb0c2', '#d3dbe4');
    grid.name = 'ground-grid';
    scene.add(grid);

    const root = new THREE.Group();
    scene.add(root);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.screenSpacePanning = true;
    controls.maxDistance = 120;
    controls.minDistance = 0.5;

    const render = () => {
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    controls.addEventListener('change', render);

    const resize = () => {
      const w = Math.max(host.clientWidth, 1);
      const h = Math.max(host.clientHeight, 1);
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // Picking: a click is a pointerdown/up pair that did not move (so orbit drags don't select).
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    const pickAt = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const pickable = [...(ctxRef.current?.objects.values() ?? [])].filter((o) => o.mesh.userData.pickable).map((o) => o.mesh);
      const hit = raycaster.intersectObjects(pickable, false)[0];
      return hit ? (hit.object.userData.elementId as string) : null;
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      propsRef.current.onPick(pickAt(e.clientX, e.clientY), e.ctrlKey || e.metaKey);
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return;
      const id = pickAt(e.clientX, e.clientY);
      renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
      const code = id ? propsRef.current.elements.find((x) => x.id === id)?.code ?? null : null;
      setHoverCode(code);
    };
    const onLeave = () => setHoverCode(null);
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);

    ctxRef.current = { renderer, labelRenderer, scene, camera, controls, root, objects: new Map(), render };
    resize();

    if (import.meta.env.DEV) {
      // Debug/test hook: screen position of an element's centre (used for automated click checks).
      (window as unknown as Record<string, unknown>).__pmcViewer = {
        /** fy: -0.5 = bottom face, 0 = centre, 0.5 = top face of the element. */
        screenPoint(id: string, fy = 0) {
          const o = ctxRef.current?.objects.get(id);
          if (!o) return null;
          const v = o.mesh.position.clone().add(new THREE.Vector3(0, fy * (o.mesh.userData.height as number), 0)).project(camera);
          const rect = renderer.domElement.getBoundingClientRect();
          return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
        },
      };
    }

    return () => {
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      ctxRef.current?.objects.forEach(disposeObjects);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labelRenderer.domElement);
      ctxRef.current = null;
    };
  }, []);

  // --- (re)build meshes when the element set changes ---
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.objects.forEach((o) => {
      ctx.root.remove(o.mesh);
      disposeObjects(o);
    });
    ctx.objects.clear();

    for (const el of props.elements) {
      const h = el.geometry.size[1];
      const mesh = new THREE.Mesh(
        elementGeometry(el.geometry),
        new THREE.MeshStandardMaterial({ color: '#9aa3ad', roughness: 0.85, metalness: 0.02 }),
      );
      mesh.position.set(...el.geometry.position);
      mesh.userData = { elementId: el.id, pickable: true, height: h };
      mesh.name = el.id;

      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 20), new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
      edges.raycast = () => {};
      mesh.add(edges);

      const div = document.createElement('div');
      div.className = 'el-label';
      div.textContent = el.code;
      const label = new CSS2DObject(div);
      label.position.set(0, h / 2 + 0.15, 0);
      mesh.add(label);

      ctx.root.add(mesh);
      ctx.objects.set(el.id, { mesh, edges, label });
    }
    if (props.frameKey === undefined || framedKey.current !== props.frameKey) {
      frameAll(ctx);
      framedKey.current = props.frameKey;
    }
    // Styles are applied by the effect below, which also depends on elements.
  }, [props.elements]);

  // --- colours, visibility, selection, labels ---
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.objects.forEach((o, id) => {
      const visible = props.visibleIds.has(id);
      const selected = props.selectedIds.has(id);
      const m = o.mesh.material;
      m.color.set(props.colors.get(id) ?? '#9aa3ad');
      m.transparent = !visible;
      m.opacity = visible ? 1 : 0.12;
      m.depthWrite = visible;
      m.emissive.copy(selected ? SEL : new THREE.Color(0x000000));
      m.emissiveIntensity = selected ? 0.55 : 0;
      m.needsUpdate = true;
      o.mesh.userData.pickable = visible;
      o.mesh.renderOrder = visible ? 0 : 1;
      o.edges.material.color.copy(selected ? SEL : EDGE_COLOR);
      o.edges.material.opacity = visible ? 1 : 0.2;
      o.edges.material.transparent = !visible;
      o.edges.scale.setScalar(selected ? 1.02 : 1);
      o.label.visible = visible && (props.showLabels || selected);
      o.label.element.classList.toggle('selected', selected);
    });
    ctx.render();
  }, [props.elements, props.colors, props.visibleIds, props.selectedIds, props.showLabels]);

  // --- reset camera ---
  useEffect(() => {
    if (props.resetSignal > 0 && ctxRef.current) frameAll(ctxRef.current);
  }, [props.resetSignal]);

  return (
    <div className="viewer-host" ref={hostRef} data-testid="model-viewer">
      {glError && <div className="viewer-error" role="alert">{glError}</div>}
      {hoverCode && <div className="viewer-hover">{hoverCode}</div>}
    </div>
  );
}

function frameAll(ctx: Ctx) {
  const box = new THREE.Box3();
  ctx.objects.forEach((o) => box.expandByObject(o.mesh));
  if (box.isEmpty()) {
    ctx.render();
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  // Fit the bounding sphere inside the narrower of the vertical / horizontal fields of view.
  const vFov = (ctx.camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * ctx.camera.aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.08;
  ctx.camera.position.copy(center).add(new THREE.Vector3(0.75, 0.55, 1).normalize().multiplyScalar(dist));
  ctx.camera.near = Math.max(dist / 200, 0.01);
  ctx.camera.far = dist * 20;
  ctx.camera.updateProjectionMatrix();
  ctx.controls.target.copy(center);
  ctx.controls.update();
  ctx.render();
}

function disposeObjects(o: ElementObjects) {
  o.mesh.geometry.dispose();
  o.mesh.material.dispose();
  o.edges.geometry.dispose();
  o.edges.material.dispose();
  o.label.element.remove();
  o.mesh.remove(o.label);
}

/**
 * Box elements become a BoxGeometry. Walls are extruded from their elevation outline with the
 * openings cut out: openings touching the wall bottom/top (doors) become notches in the outline,
 * the rest become holes. Result is centred on the element position like a box.
 */
export function elementGeometry(g: ElementGeometry): THREE.BufferGeometry {
  if (g.shape !== 'wall' || !g.openings?.length) return new THREE.BoxGeometry(...g.size);
  const { alongX, length: L, height: H, thickness: T } = wallDims(g);
  const EPS = 1e-4;
  const ops = [...g.openings].sort((a, b) => a.center - b.center);
  const bottomNotches = ops.filter((o) => o.bottom <= EPS);
  const topNotches = ops.filter((o) => o.bottom > EPS && o.bottom + o.height >= H - EPS);
  const holes = ops.filter((o) => !bottomNotches.includes(o) && !topNotches.includes(o));

  const shape = new THREE.Shape();
  shape.moveTo(-L / 2, -H / 2);
  for (const o of bottomNotches) {
    shape.lineTo(o.center - o.width / 2, -H / 2);
    shape.lineTo(o.center - o.width / 2, -H / 2 + o.height);
    shape.lineTo(o.center + o.width / 2, -H / 2 + o.height);
    shape.lineTo(o.center + o.width / 2, -H / 2);
  }
  shape.lineTo(L / 2, -H / 2);
  shape.lineTo(L / 2, H / 2);
  for (const o of [...topNotches].reverse()) {
    shape.lineTo(o.center + o.width / 2, H / 2);
    shape.lineTo(o.center + o.width / 2, -H / 2 + o.bottom);
    shape.lineTo(o.center - o.width / 2, -H / 2 + o.bottom);
    shape.lineTo(o.center - o.width / 2, H / 2);
  }
  shape.lineTo(-L / 2, H / 2);
  shape.closePath();
  for (const o of holes) {
    const hole = new THREE.Path();
    const y0 = -H / 2 + o.bottom;
    hole.moveTo(o.center - o.width / 2, y0);
    hole.lineTo(o.center - o.width / 2, y0 + o.height);
    hole.lineTo(o.center + o.width / 2, y0 + o.height);
    hole.lineTo(o.center + o.width / 2, y0);
    hole.closePath();
    shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false });
  geo.translate(0, 0, -T / 2);
  if (!alongX) geo.rotateY(-Math.PI / 2); // local +X (wall length) → world +Z
  return geo;
}

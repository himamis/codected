// three-view.js — the third dimension, loaded on demand.
//
//   open3D({ name, label, f(x, y, t), color })  → shows #modal-3d and plots z = f(x, y, t)
//   close3D()                                   → tears everything down, focus goes back to whatever opened it
//
// three.js is never part of the initial payload: it is dynamically imported (via the page's import map)
// the first time somebody types something with a `y` in it.
//
// Coordinates: math is z-up, three.js is y-up. Math (x, y, z) is drawn at three (x, z, -y), which keeps
// the system right-handed, so the picture matches what you would sketch on paper.

import { toast } from './ui.js';

const N = 90;              // grid segments per side → (N+1)² vertices
const HALF = 6;            // domain is [-HALF, HALF]²
const ZCAP = 6;            // displayed |z| is clamped to this
const SANE = 1e6;          // anything bigger is treated as an asymptote (gap)
const JUMP = ZCAP * 0.75;
const WIRE_EVERY = 2;      // N must be a multiple of this so the border lines exist   // neighbouring vertices further apart than this → don't connect (asymptote walls)
const AXIS_LEN = HALF + 1.6;
const BG = 0x05060a;
const STOPS = ['#3df5ff', '#8a7dff', '#ff3df2']; // low → mid → high
const AXIS_COLORS = { x: '#ff4d6d', y: '#b6ff3d', z: '#3df5ff' };

let lib = null;            // { THREE, OrbitControls, post }
let libPromise = null;
let session = null;        // live scene, see buildScene()
let openSeq = 0;           // bumps on every open/close so stale async opens bail out
let wired = false;
let opener = null;         // the element that had focus when the modal opened (focus goes back there)

const THREE_BASE = 'https://cdn.jsdelivr.net/npm/three@0.186.1/';
// three.module.js → three.core.js and the bloom passes → shaders are a serial waterfall; hint the deep end up front
const PRELOAD = [
  'build/three.core.js',
  'examples/jsm/postprocessing/Pass.js',
  'examples/jsm/postprocessing/ShaderPass.js',
  'examples/jsm/postprocessing/MaskPass.js',
  'examples/jsm/shaders/CopyShader.js',
  'examples/jsm/shaders/LuminosityHighPassShader.js',
  'examples/jsm/shaders/OutputShader.js',
];
let preloaded = false;
function preloadDeps() {
  if (preloaded || typeof document === 'undefined') return;
  preloaded = true;
  for (const path of PRELOAD) {
    const l = document.createElement('link');
    l.rel = 'modulepreload';
    l.href = THREE_BASE + path;
    l.crossOrigin = 'anonymous';
    document.head.append(l);
  }
}

const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);

/* ------------------------------------------------------------------------------------------------ */
/* loading                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

function loadThree() {
  if (lib) return Promise.resolve(lib);
  if (!libPromise) {
    preloadDeps();
    // Post-processing (bloom) is a nice-to-have: start it in parallel, but never let it block or break.
    const postP = Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]).then(
      ([ec, rp, ub, op]) => ({
        EffectComposer: ec.EffectComposer,
        RenderPass: rp.RenderPass,
        UnrealBloomPass: ub.UnrealBloomPass,
        OutputPass: op.OutputPass,
      }),
      () => null,
    );
    libPromise = Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')])
      .then(async ([THREE, oc]) => {
        lib = { THREE, OrbitControls: oc.OrbitControls, post: await postP };
        return lib;
      })
      .catch((err) => {
        libPromise = null; // allow a retry later (e.g. when the wifi comes back)
        throw err;
      });
  }
  return libPromise;
}

/* ------------------------------------------------------------------------------------------------ */
/* modal plumbing                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

function dom() {
  const modal = document.getElementById('modal-3d');
  if (!modal) return null;
  const host = document.getElementById('three-host');
  const closeBtn = document.getElementById('close-3d');
  const hint = modal.querySelector('.hint');
  let title = modal.querySelector('#title-3d') || modal.querySelector('header h1, header h2, header h3, header .title');
  if (!title) {
    const header = modal.querySelector('header');
    if (header) {
      title = document.createElement('h2');
      title.id = 'title-3d';
      header.insertBefore(title, header.firstChild);
    }
  }
  if (title && !title.id) title.id = 'title-3d';
  return { modal, host, closeBtn, hint, title };
}

function isOpen() {
  const m = document.getElementById('modal-3d');
  return !!m && !m.hidden;
}

function wire() {
  if (wired) return;
  const d = dom();
  if (!d) return;
  wired = true;
  d.closeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    close3D();
  });
  // Click on the dimmed backdrop (outside .modal-3d-inner) closes too.
  d.modal.addEventListener('pointerdown', (e) => {
    if (e.target === d.modal) close3D();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close3D();
      } else if (e.key === 'Tab') {
        // Only one focusable thing lives in here; keep focus from wandering onto the plane behind.
        const btn = document.getElementById('close-3d');
        if (btn) {
          e.preventDefault();
          btn.focus({ preventScroll: true });
        }
      }
    },
    true,
  );
}

function showModal(d, obj) {
  const label = obj?.label || (obj?.name ? `${obj.name}(x, y)` : 'z = f(x, y)');
  if (d.title) d.title.textContent = label;
  d.modal.setAttribute('role', 'dialog');
  d.modal.setAttribute('aria-modal', 'true');
  if (d.title) d.modal.setAttribute('aria-labelledby', d.title.id);
  if (d.hint) d.hint.textContent = baseHint();
  if (d.modal.hidden) {
    const ae = document.activeElement;
    opener = ae && ae !== document.body && !d.modal.contains(ae) ? ae : null;
    d.modal.hidden = false;
    // Next frame, so CSS can transition from the un-hidden state.
    requestAnimationFrame(() => d.modal.classList.add('is-open'));
    document.dispatchEvent(new CustomEvent('three:open', { detail: { label } }));
  }
  d.closeBtn?.focus({ preventScroll: true });
}

function hideModal() {
  const d = dom();
  if (!d || d.modal.hidden) return false;
  d.modal.classList.remove('is-open');
  d.modal.hidden = true;
  document.dispatchEvent(new CustomEvent('three:close'));
  return true;
}

function baseHint() {
  return mq('(pointer: coarse)')
    ? 'drag to orbit · pinch to zoom · × to close'
    : 'drag to orbit · scroll to zoom · Esc to close';
}

function setLoading(host, on) {
  host.querySelector('.three-loading')?.remove();
  if (!on) return;
  const el = document.createElement('div');
  el.className = 'three-loading';
  el.setAttribute('role', 'status');
  el.textContent = 'Loading the third dimension…';
  Object.assign(el.style, {
    position: 'absolute',
    inset: '0',
    display: 'grid',
    placeItems: 'center',
    font: '500 13px/1.4 "JetBrains Mono", ui-monospace, monospace',
    color: '#9aa3c7',
    letterSpacing: '.04em',
    textShadow: '0 0 12px rgba(61,245,255,.45)',
    pointerEvents: 'none',
  });
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(el);
}

/* ------------------------------------------------------------------------------------------------ */
/* public API                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export async function open3D(obj) {
  const seq = ++openSeq;
  wire();
  const d = dom();
  if (!d || !d.host) {
    toast('The 3D view went missing. Classic.', { kind: 'error' });
    return;
  }
  if (typeof obj?.f !== 'function') {
    toast('That surface has no function. Bold, but no.', { kind: 'error' });
    return;
  }

  if (session) {
    teardown(session);
    session = null;
  }
  showModal(d, obj);
  setLoading(d.host, !lib);

  let L;
  try {
    L = await loadThree();
  } catch (err) {
    if (seq !== openSeq) return;
    console.warn('[three-view] three.js failed to load:', err);
    setLoading(d.host, false);
    finishClose();
    toast("Couldn't load three.js. The third dimension is offline — try again in a bit.", { kind: 'error', ms: 4800 });
    return;
  }
  if (seq !== openSeq || !isOpen()) return; // closed (or replaced) while loading

  setLoading(d.host, false);
  try {
    session = buildScene(L, obj, d);
  } catch (err) {
    console.warn('[three-view] WebGL setup failed:', err);
    session = null;
    finishClose();
    toast('WebGL said no. Your GPU is taking a well-deserved break.', { kind: 'error', ms: 4800 });
  }
}

export function close3D() {
  openSeq++;
  finishClose();
}

function finishClose() {
  if (session) {
    teardown(session);
    session = null;
  }
  const d = dom();
  if (d?.host) setLoading(d.host, false);
  if (hideModal()) {
    // back to whatever opened it. Never pop a phone keyboard on close: #input only with a fine pointer.
    const coarse = mq('(pointer: coarse)');
    const back = opener;
    opener = null;
    const ok = back?.isConnected && !back.closest?.('[hidden]') && !(back.id === 'input' && coarse);
    const target = ok ? back : document.getElementById('algebra-toggle');
    target?.focus({ preventScroll: true });
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* the scene                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

function safeFn(f) {
  return (x, y, t) => {
    try {
      const z = f(x, y, t);
      return typeof z === 'number' ? z : NaN;
    } catch {
      return NaN;
    }
  };
}

function dependsOnT(f) {
  const probes = [
    [0.3, -0.7], [1.9, 2.4], [-3.1, 0.6], [4.2, -2.2], [-1.4, -4.6], [0, 0], [2.7, 5.1], [-5.3, 3.3],
  ];
  for (const [x, y] of probes) {
    const a = f(x, y, 0.37);
    const b = f(x, y, 1.91);
    if (Number.isFinite(a) !== Number.isFinite(b)) return true;
    if (Number.isFinite(a) && Math.abs(a - b) > 1e-9 * (1 + Math.abs(a))) return true;
  }
  return false;
}

// Robust vertical scale + colour range from a coarse sampling (over a few t values if animated).
function measure(f, ts) {
  const vals = [];
  const step = (2 * HALF) / 30;
  for (const t of ts) {
    for (let j = 0; j <= 30; j++) {
      for (let i = 0; i <= 30; i++) {
        const z = f(-HALF + i * step, -HALF + j * step, t);
        if (Number.isFinite(z) && Math.abs(z) < SANE) vals.push(z);
      }
    }
  }
  if (!vals.length) return { scale: 1, lo: -1, hi: 1, empty: true };
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  const lo = q(0.01);
  const hi = q(0.99);
  const big = Math.max(Math.abs(lo), Math.abs(hi));
  const scale = big > ZCAP ? ZCAP / big : 1;
  let dlo = Math.max(-ZCAP, lo * scale);
  let dhi = Math.min(ZCAP, hi * scale);
  if (dhi - dlo < 1e-6) {
    dlo -= 1;
    dhi += 1;
  }
  return { scale, lo: dlo, hi: dhi, empty: false };
}

function prettyScale(s) {
  if (s >= 0.1) return s.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return s.toPrecision(2);
}

function labelSprite(THREE, text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = '600 76px "JetBrains Mono", ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = 18; // one-off texture, not a hot loop
  g.fillText(text, 64, 68);
  g.shadowBlur = 0;
  g.fillStyle = '#ffffff';
  g.globalAlpha = 0.85;
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.9, 0.9, 1);
  return s;
}

function glowAxis(THREE, group, from, to, color) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const col = new THREE.Color(color);
  // crisp core line
  const lg = new THREE.BufferGeometry().setFromPoints([a, b]);
  const lm = new THREE.LineBasicMaterial({
    color: col, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  group.add(new THREE.Line(lg, lm));
  // two soft halos (thin cylinders), because WebGL lines are always 1px
  const len = a.distanceTo(b);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  for (const [r, o] of [[0.035, 0.32], [0.11, 0.07]]) {
    const cg = new THREE.CylinderGeometry(r, r, len, 10, 1, true);
    const cm = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const m = new THREE.Mesh(cg, cm);
    m.position.copy(mid);
    m.quaternion.copy(quat);
    group.add(m);
  }
  // arrow head
  const hg = new THREE.ConeGeometry(0.13, 0.42, 14);
  const hm = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const head = new THREE.Mesh(hg, hm);
  head.position.copy(b);
  head.quaternion.copy(quat);
  group.add(head);
}

function buildScene(L, obj, d) {
  const { THREE, OrbitControls, post } = L;
  const host = d.host;
  const reduced = mq('(prefers-reduced-motion: reduce)');
  const coarse = mq('(pointer: coarse)');
  const f = safeFn(obj.f);
  const usesT = dependsOnT(f);
  const animated = usesT && !reduced;
  const range = measure(f, usesT ? [0, 0.8, 1.6, 2.4, 3.2, 4.0, 4.8, 5.6] : [0]);

  /* renderer ------------------------------------------------------------------------------------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr());
  renderer.setClearColor(BG, 1);
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-label', `3D plot of ${obj.label || 'a surface'}`);
  canvas.setAttribute('role', 'img');
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });
  host.appendChild(canvas);

  const size = () => ({ w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) });
  let { w, h } = size();
  renderer.setSize(w, h, false);

  /* scene ---------------------------------------------------------------------------------------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 20, 52);

  const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 300);
  const midY = (range.lo + range.hi) / 2;
  const target = new THREE.Vector3(0, midY * 0.6, 0);
  const fitDist = () => {
    const R = Math.hypot(HALF, HALF, Math.max(Math.abs(range.lo), Math.abs(range.hi), 2));
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    return (R / Math.sin(Math.min(vfov, hfov) / 2)) * (camera.aspect < 1 ? 0.7 : 0.82); // corners may crop a bit on phones
  };
  const viewDir = new THREE.Vector3(1, 0.62, 1.12).normalize();
  const finalPos = target.clone().addScaledVector(viewDir, fitDist());
  camera.position.copy(reduced ? finalPos : target.clone().addScaledVector(viewDir, fitDist() * 1.9).add(new THREE.Vector3(-6, 6, 0)));
  camera.lookAt(target);

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.9;
  controls.minDistance = 5;
  controls.maxDistance = 80;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 0.9; // ~67 s per orbit
  let userBusy = false;
  let resumeTimer = 0;
  controls.addEventListener('start', () => {
    userBusy = true;
    controls.autoRotate = false;
    clearTimeout(resumeTimer);
  });
  controls.addEventListener('end', () => {
    userBusy = false;
    clearTimeout(resumeTimer);
    if (!reduced) resumeTimer = setTimeout(() => { controls.autoRotate = true; }, 2600);
  });

  /* floor grid + axes ---------------------------------------------------------------------------- */
  const floorY = Math.min(range.lo, 0) - 1.1;
  const grid = new THREE.GridHelper(60, 60, 0x8a7dff, 0x2a3160);
  grid.position.y = floorY;
  for (const m of [].concat(grid.material)) {
    m.transparent = true;
    m.opacity = 0.22;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
  }
  scene.add(grid);
  const innerGrid = new THREE.GridHelper(2 * HALF, 12, 0x3df5ff, 0x3df5ff);
  innerGrid.position.y = floorY + 0.002;
  for (const m of [].concat(innerGrid.material)) {
    m.transparent = true;
    m.opacity = 0.09;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
  }
  scene.add(innerGrid);

  const axes = new THREE.Group();
  glowAxis(THREE, axes, [-AXIS_LEN, 0, 0], [AXIS_LEN, 0, 0], AXIS_COLORS.x);  // math x
  glowAxis(THREE, axes, [0, 0, AXIS_LEN], [0, 0, -AXIS_LEN], AXIS_COLORS.y);  // math y → three -z
  glowAxis(THREE, axes, [0, floorY, 0], [0, Math.max(range.hi, 0) + 1.8, 0], AXIS_COLORS.z); // math z → three y
  const lx = labelSprite(THREE, 'x', AXIS_COLORS.x); lx.position.set(AXIS_LEN + 0.6, 0, 0);
  const ly = labelSprite(THREE, 'y', AXIS_COLORS.y); ly.position.set(0, 0, -AXIS_LEN - 0.6);
  const lz = labelSprite(THREE, 'z', AXIS_COLORS.z); lz.position.set(0, Math.max(range.hi, 0) + 2.4, 0);
  axes.add(lx, ly, lz);
  scene.add(axes);

  /* surface -------------------------------------------------------------------------------------- */
  const S = N + 1;
  const V = S * S;
  const pos = new Float32Array(V * 3);
  const col = new Float32Array(V * 3);
  const zs = new Float32Array(V);
  const valid = new Uint8Array(V);
  const lineIdx = new Uint16Array(2 * 2 * N * S);
  const triIdx = new Uint16Array(6 * N * N);

  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(animated ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3).setUsage(animated ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
  const lineIdxAttr = new THREE.BufferAttribute(lineIdx, 1).setUsage(THREE.DynamicDrawUsage);
  const triIdxAttr = new THREE.BufferAttribute(triIdx, 1).setUsage(THREE.DynamicDrawUsage);

  const wireGeo = new THREE.BufferGeometry();
  wireGeo.setAttribute('position', posAttr);
  wireGeo.setAttribute('color', colAttr);
  wireGeo.setIndex(lineIdxAttr);
  const solidGeo = new THREE.BufferGeometry();
  solidGeo.setAttribute('position', posAttr);
  solidGeo.setAttribute('color', colAttr);
  solidGeo.setIndex(triIdxAttr);
  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.hypot(HALF, HALF, ZCAP));
  wireGeo.boundingSphere = sphere;
  solidGeo.boundingSphere = sphere.clone();

  const wireMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const solidMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.075, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const solid = new THREE.Mesh(solidGeo, solidMat);
  const wire = new THREE.LineSegments(wireGeo, wireMat);
  solid.frustumCulled = wire.frustumCulled = false;
  solid.renderOrder = 1;
  wire.renderOrder = 2;
  scene.add(solid, wire);

  const stops = STOPS.map((c) => new THREE.Color(c)); // linear working space
  const span = range.hi - range.lo;
  const xs = new Float32Array(S);
  for (let i = 0; i < S; i++) xs[i] = -HALF + (i * 2 * HALF) / N;

  function update(t, rise) {
    // evaluate
    for (let j = 0; j < S; j++) {
      const y = xs[j];
      for (let i = 0; i < S; i++) {
        const k = j * S + i;
        let z = f(xs[i], y, t);
        const k3 = k * 3;
        if (!Number.isFinite(z) || Math.abs(z) > SANE) {
          valid[k] = 0;
          pos[k3] = xs[i]; pos[k3 + 1] = 0; pos[k3 + 2] = -y;
          col[k3] = col[k3 + 1] = col[k3 + 2] = 0;
          continue;
        }
        z *= range.scale;
        if (z > ZCAP) z = ZCAP; else if (z < -ZCAP) z = -ZCAP;
        valid[k] = 1;
        zs[k] = z;
        pos[k3] = xs[i];
        pos[k3 + 1] = z * rise;
        pos[k3 + 2] = -y;
        // colour by height: cyan → violet → magenta
        let u = (z - range.lo) / span;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const seg = u < 0.5 ? 0 : 1;
        const a = stops[seg], b = stops[seg + 1];
        const v = seg ? (u - 0.5) * 2 : u * 2;
        col[k3] = a.r + (b.r - a.r) * v;
        col[k3 + 1] = a.g + (b.g - a.g) * v;
        col[k3 + 2] = a.b + (b.b - a.b) * v;
      }
    }
    // connect neighbours (skip NaN gaps and asymptote jumps)
    let ln = 0;
    let tn = 0;
    const ok = (a, b) => valid[a] && valid[b] && Math.abs(zs[a] - zs[b]) < JUMP;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const k = j * S + i;
        // wire lines on every WIRE_EVERY-th row/column, but sampled at full resolution → smooth + uncluttered
        if (i < N && j % WIRE_EVERY === 0 && ok(k, k + 1)) { lineIdx[ln++] = k; lineIdx[ln++] = k + 1; }
        if (j < N && i % WIRE_EVERY === 0 && ok(k, k + S)) { lineIdx[ln++] = k; lineIdx[ln++] = k + S; }
        if (i < N && j < N) {
          const a = k, b = k + 1, c = k + S, e = k + S + 1;
          if (ok(a, b) && ok(a, c) && ok(b, c)) { triIdx[tn++] = a; triIdx[tn++] = b; triIdx[tn++] = c; }
          if (ok(b, e) && ok(c, e) && ok(b, c)) { triIdx[tn++] = b; triIdx[tn++] = e; triIdx[tn++] = c; }
        }
      }
    }
    wireGeo.setDrawRange(0, ln);
    solidGeo.setDrawRange(0, tn);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    lineIdxAttr.needsUpdate = true;
    triIdxAttr.needsUpdate = true;
  }

  /* bloom (optional) ----------------------------------------------------------------------------- */
  let composer = null;
  let bloom = null;
  if (post) {
    try {
      composer = new post.EffectComposer(renderer);
      composer.setPixelRatio(dpr());
      composer.setSize(w, h);
      composer.addPass(new post.RenderPass(scene, camera));
      bloom = new post.UnrealBloomPass(new THREE.Vector2(w, h), coarse ? 0.55 : 0.62, 0.35, 0.12);
      composer.addPass(bloom);
      composer.addPass(new post.OutputPass());
    } catch (err) {
      console.warn('[three-view] bloom unavailable, glowing manually:', err);
      composer?.dispose?.();
      composer = null;
    }
  }
  const render = () => (composer ? composer.render() : renderer.render(scene, camera));

  /* hint ----------------------------------------------------------------------------------------- */
  if (d.hint) {
    const extra = [];
    if (range.empty) extra.push('nothing real to plot here — try fewer square roots of negatives');
    else if (range.scale < 0.999) extra.push(`z squashed ×${prettyScale(range.scale)} to fit`);
    if (usesT && reduced) extra.push('t paused (reduced motion)');
    d.hint.textContent = [baseHint(), ...extra].join(' · ');
  }

  /* resize --------------------------------------------------------------------------------------- */
  let raf = 0;
  let running = true;
  const onResize = () => {
    ({ w, h } = size());
    const r = dpr();
    renderer.setPixelRatio(r);
    renderer.setSize(w, h, false);
    if (composer) {
      composer.setPixelRatio(r);
      composer.setSize(w, h);
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!running) render();
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  ro?.observe(host);
  window.addEventListener('resize', onResize);

  /* loop ----------------------------------------------------------------------------------------- */
  const INTRO = reduced ? 0 : 1.1;
  const startPos = camera.position.clone();
  const t0 = performance.now();
  let last = t0;
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const easeBack = (x) => { const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  let introDone = INTRO === 0;
  update(0, introDone ? 1 : 0);

  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const el = (now - t0) / 1000;

    if (!introDone) {
      const p = Math.min(1, el / INTRO);
      if (!userBusy) camera.position.lerpVectors(startPos, finalPos, easeOut(p));
      update(animated ? el : 0, easeBack(p));
      if (p >= 1) introDone = true;
    } else if (animated) {
      update(el, 1);
    }
    controls.update(dt);
    render();
  };
  onResize(); // first paint at the real size (the modal may have just been un-hidden)
  render();
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      clearTimeout(resumeTimer);
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      controls.dispose();
      const geos = new Set();
      const mats = new Set();
      scene.traverse((o) => {
        if (o.geometry) geos.add(o.geometry);
        for (const m of [].concat(o.material || [])) mats.add(m);
      });
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
      if (composer) {
        for (const p of composer.passes) p.dispose?.();
        composer.dispose?.();
      }
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss(); // hand the WebGL context back now, not whenever GC feels like it
      canvas.remove();
    },
  };
}

function teardown(s) {
  try {
    s.dispose();
  } catch (err) {
    console.warn('[three-view] dispose hiccup:', err);
  }
}

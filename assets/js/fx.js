// fx.js — glowing nonsense drawn on the plane canvas: bugs, butterflies, confetti.
// createFx(plane, { reducedMotion }) → { spawnBugs, butterflies, confetti, stopAll, onBugsChanged, squashAll, bugCount }
// Everything is drawn through plane.addOverlay(draw); counts are capped; finished particles are dropped.

const P = { cyan: '#3df5ff', violet: '#8a7dff', magenta: '#ff3df2', lime: '#b6ff3d', amber: '#ffb23d', red: '#ff4d6d' };
const PALETTE = Object.values(P);
const BUG_COLORS = [P.lime, P.lime, P.red, P.amber, P.magenta, P.cyan];
const WING_PAIRS = [[P.cyan, P.violet], [P.magenta, P.amber], [P.lime, P.cyan], [P.violet, P.magenta], [P.amber, P.red], [P.cyan, P.magenta]];
const CAP = { bugs: 40, flies: 30, sparks: 700, texts: 24 };
const SPLAT_WORDS = ['splat', 'squish', 'fixed', '−1 bug', 'splat', 'crunch'];
const HIT_RADIUS = 20; // css px
const TAU = Math.PI * 2;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeOutBack = (t) => { const c = 1.9; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };

function rgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbaCache = new Map();
function rgba(hex, a) {
  let c = rgbaCache.get(hex);
  if (!c) { c = rgb(hex).join(','); rgbaCache.set(hex, c); }
  return `rgba(${c},${a.toFixed(3)})`;
}

function mix(hex, hex2, k) {
  const a = rgb(hex), b = rgb(hex2);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * k).toString(16).padStart(2, '0')).join('');
}

// Pre-rendered soft glow sprites (one per color) — cheaper than shadowBlur or per-frame gradients.
const sprites = new Map();
function glowSprite(hex) {
  let s = sprites.get(hex);
  if (s) return s;
  const size = 64;
  s = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = s.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgba(hex, 1));
  grad.addColorStop(0.18, rgba(hex, 0.55));
  grad.addColorStop(0.5, rgba(hex, 0.14));
  grad.addColorStop(1, rgba(hex, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  sprites.set(hex, s);
  return s;
}
function blob(c, hex, x, y, r, a) {
  if (a <= 0.003) return;
  c.globalAlpha = a;
  c.drawImage(glowSprite(hex), x - r, y - r, r * 2, r * 2);
  c.globalAlpha = 1;
}

export function createFx(plane, { reducedMotion = false } = {}) {
  const reduced = () => (typeof reducedMotion === 'function' ? !!reducedMotion() : !!reducedMotion);
  const bugs = [];
  const flies = [];
  const sparks = [];
  const texts = [];
  const listeners = [];
  let squashed = 0;
  let overlay = false;
  let last = 0;

  const W = () => plane.canvas?.clientWidth || (typeof innerWidth !== 'undefined' ? innerWidth : 800);
  const H = () => plane.canvas?.clientHeight || (typeof innerHeight !== 'undefined' ? innerHeight : 600);
  const scale = () => plane.camera?.s || 40;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ptime = () => (Number.isFinite(plane.time) ? plane.time : 0);

  function ensureOverlay() {
    if (overlay || !plane.addOverlay) return;
    overlay = true;
    last = now();
    plane.addOverlay(draw);
  }

  function aliveBugs() { return bugs.filter((b) => b.state === 'alive').length; }
  function notify(reason) {
    const remaining = aliveBugs();
    for (const fn of listeners) { try { fn(remaining, squashed, reason); } catch (e) { console.error(e); } }
    if (remaining === 0 && reason !== 'spawn') squashed = 0;
  }

  // ---- curves -------------------------------------------------------------------------
  function curves() {
    const out = [];
    if (!plane.objects) return out;
    for (const o of plane.objects.values()) {
      if (o && o.kind === 'fn2d' && o.visible !== false && typeof o.f === 'function') out.push(o);
    }
    return out;
  }
  function evalAt(o, x) {
    try { const y = o.f(x, ptime()); return Number.isFinite(y) ? y : NaN; } catch { return NaN; }
  }

  // ---- bugs ---------------------------------------------------------------------------
  function findPerch(list) {
    const w = W(), h = H();
    for (let tries = 0; tries < 40 && list.length; tries++) {
      const o = pick(list);
      const px = rand(w * 0.08, w * 0.92);
      const wx = plane.screenToWorld(px, h / 2).x;
      const wy = evalAt(o, wx);
      if (!Number.isFinite(wy)) continue;
      const sy = plane.worldToScreen(wx, wy).y;
      if (sy > 70 && sy < h - 70) return { o, x: wx, y: wy };
    }
    return null;
  }

  function spawnBugs(n = 7) {
    const room = CAP.bugs - bugs.length;
    n = Math.max(0, Math.min(n | 0, room));
    if (!n) return 0;
    ensureOverlay();
    if (aliveBugs() === 0) squashed = 0;
    const list = curves();
    const w = W(), h = H();
    for (let i = 0; i < n; i++) {
      const perch = findPerch(list);
      const b = {
        state: 'alive', mode: perch ? 'curve' : 'wander', curveId: perch?.o.id,
        x: 0, y: 0, dir: Math.random() < 0.5 ? -1 : 1, speed: rand(28, 54),
        color: pick(BUG_COLORS), size: rand(6.4, 8.4), phase: rand(0, TAU), angle: rand(0, TAU),
        age: 0, delay: reduced() ? 0 : i * 0.11, pause: 0, vy: 0, squashT: 0, spots: Math.random() < 0.6,
        seed: rand(0, 100),
      };
      if (perch) { b.x = perch.x; b.y = perch.y; } else {
        const wpos = plane.screenToWorld(rand(w * 0.15, w * 0.85), rand(h * 0.2, h * 0.8));
        b.x = wpos.x; b.y = wpos.y;
      }
      if (b.mode === 'curve') b.angle = curveAngle(b, plane.camera?.s || 40) ?? b.angle;
      bugs.push(b);
    }
    notify('spawn');
    return n;
  }

  function curveAngle(b, s) {
    const o = plane.objects?.get(b.curveId);
    if (!o) return null;
    const h = 1.5 / s;
    const y0 = evalAt(o, b.x), y1 = evalAt(o, b.x + h * b.dir);
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
    const p0 = plane.worldToScreen(b.x, y0), p1 = plane.worldToScreen(b.x + h * b.dir, y1);
    return Math.atan2(p1.y - p0.y, p1.x - p0.x);
  }

  function updateBug(b, dt, s, w, h) {
    if (b.delay > 0) { b.delay -= dt; return; }
    b.age += dt;
    if (b.state === 'squashed') { b.squashT += dt; return; }
    const still = reduced();
    let moving = !still;
    if (moving) {
      if (b.pause > 0) { b.pause -= dt; moving = false; }
      else if (Math.random() < dt * 0.18) { b.pause = rand(0.3, 1.1); if (Math.random() < 0.35) b.dir *= -1; }
    }
    const m = 24; // screen margin
    if (b.mode === 'curve') {
      const o = plane.objects?.get(b.curveId);
      if (!o || o.visible === false || typeof o.f !== 'function') { b.mode = 'fall'; b.vy = 0; return; }
      const hh = 1.5 / s;
      let y0 = evalAt(o, b.x);
      let y1 = evalAt(o, b.x + hh * b.dir);
      if (!Number.isFinite(y0)) { b.mode = 'fall'; b.vy = 0; return; }
      if (!Number.isFinite(y1)) { b.dir *= -1; y1 = evalAt(o, b.x + hh * b.dir); }
      const p0 = plane.worldToScreen(b.x, y0);
      const p1 = Number.isFinite(y1) ? plane.worldToScreen(b.x + hh * b.dir, y1) : { x: p0.x + b.dir, y: p0.y };
      const dsx = p1.x - p0.x, dsy = p1.y - p0.y;
      const seg = Math.hypot(dsx, dsy) || 1;
      if (moving) {
        const outward = (p0.x < m && dsx < 0) || (p0.x > w - m && dsx > 0) || (p0.y < m && dsy < 0) || (p0.y > h - m && dsy > 0);
        if (outward) b.dir *= -1;
        else {
          const dx = (b.speed * dt / seg) * hh * b.dir; // constant screen speed along the curve
          b.x += dx;
          b.phase += dt * b.speed * 0.32;
        }
      }
      b.y = evalAt(o, b.x);
      if (!Number.isFinite(b.y)) { b.y = y0; b.mode = 'fall'; b.vy = 0; return; }
      const target = Math.atan2(dsy, dsx);
      b.angle += angDiff(target, b.angle) * Math.min(1, dt * 16);
      return;
    }
    if (b.mode === 'fall') {
      // the curve vanished under its feet: gravity, then try to land on another curve
      b.vy += 1400 * dt;
      const before = plane.worldToScreen(b.x, b.y);
      b.y -= (b.vy * dt) / s;
      const after = plane.worldToScreen(b.x, b.y);
      b.angle += dt * 7;
      for (const o of curves()) {
        const cy = evalAt(o, b.x);
        if (!Number.isFinite(cy)) continue;
        const sy = plane.worldToScreen(b.x, cy).y;
        if (sy >= before.y - 1 && sy <= after.y + 1) { b.mode = 'curve'; b.curveId = o.id; b.y = cy; b.vy = 0; return; }
      }
      if (after.y > h + 60) { b.state = 'gone'; notify('escaped'); }
      return;
    }
    // wander: no curves to crawl on, so roam the plane like it owns it
    const p = plane.worldToScreen(b.x, b.y);
    if (moving) {
      b.angle += (Math.sin(b.age * 1.7 + b.seed) * 1.6 + Math.sin(b.age * 4.1 + b.seed * 2) * 0.8) * dt;
      const cx = w / 2 - p.x, cy = h / 2 - p.y;
      if (p.x < m * 3 || p.x > w - m * 3 || p.y < m * 3 || p.y > h - m * 3) {
        b.angle += angDiff(Math.atan2(cy, cx), b.angle) * Math.min(1, dt * 3);
      }
      const d = b.speed * dt;
      b.x += (Math.cos(b.angle) * d) / s;
      b.y -= (Math.sin(b.angle) * d) / s;
      b.phase += dt * b.speed * 0.32;
    }
  }

  function drawBug(c, b, t) {
    if (b.delay > 0 || b.state === 'gone') return;
    const p = plane.worldToScreen(b.x, b.y);
    const L = b.size;
    let alpha = 1, sx = 1, sy = 1;
    const pop = reduced() ? 1 : easeOutBack(clamp(b.age / 0.35, 0, 1));
    if (b.state === 'squashed') {
      const e = clamp(b.squashT / 0.1, 0, 1);
      sx = 1 + 0.55 * e; sy = 1 - 0.78 * e;
      alpha = 1 - clamp((b.squashT - 0.45) / 1.1, 0, 1);
      if (alpha <= 0) { b.state = 'gone'; return; }
      // splat ring
      const rt = clamp(b.squashT / 0.4, 0, 1);
      if (rt < 1 && !reduced()) {
        c.globalCompositeOperation = 'lighter';
        c.strokeStyle = rgba(b.color, 0.7 * (1 - rt));
        c.lineWidth = 1.5;
        c.beginPath(); c.arc(p.x, p.y, 4 + rt * 18, 0, TAU); c.stroke();
      }
      // splat goo (stays a moment, fades)
      c.globalCompositeOperation = 'lighter';
      blob(c, b.color, p.x, p.y, L * 3.4, 0.35 * alpha);
    }
    if (pop <= 0.01) return;
    const tt = reduced() ? 0 : t; // sitting still means sitting still: no wiggle, no pulse
    c.save();
    c.translate(p.x, p.y);
    c.rotate(b.angle);
    c.scale(pop * sx, pop * sy);

    // halo
    c.globalCompositeOperation = 'lighter';
    if (b.state === 'alive') blob(c, b.color, 0, 0, L * 3.6, 0.42 + 0.12 * Math.sin(tt * 3 + b.seed));

    // legs: tripod gait (front+back on one side move with the middle of the other)
    c.strokeStyle = rgba(b.color, 0.9 * alpha);
    c.lineWidth = 1.15;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    for (let i = 0; i < 3; i++) {
      const lx = (i - 1) * L * 0.48;
      for (const side of [-1, 1]) {
        const ph = b.phase + (i % 2 === 0 ? 0 : Math.PI) + (side > 0 ? Math.PI : 0);
        const swing = b.state === 'alive' ? Math.sin(ph) * L * 0.28 : 0;
        const lift = b.state === 'alive' ? Math.max(0, Math.cos(ph)) * L * 0.12 : 0;
        const splay = b.state === 'squashed' ? 1.35 : 1;
        c.moveTo(lx, side * L * 0.4);
        c.lineTo(lx + swing * 0.55 + (i - 1) * L * 0.16, side * (L * 0.82 - lift) * splay);
        c.lineTo(lx + swing + (i - 1) * L * 0.34, side * (L * 1.06 - lift) * splay);
      }
    }
    // antennae
    const wig = Math.sin(tt * 7 + b.seed) * L * 0.12;
    for (const side of [-1, 1]) {
      c.moveTo(L * 0.92, side * L * 0.12);
      c.quadraticCurveTo(L * 1.25, side * (L * 0.16 + wig), L * 1.42, side * (L * 0.46 + wig * side));
    }
    c.stroke();
    // antenna tips
    c.fillStyle = rgba(b.color, alpha);
    for (const side of [-1, 1]) { c.beginPath(); c.arc(L * 1.42, side * (L * 0.46 + wig * side), 0.95, 0, TAU); c.fill(); }

    // shell
    c.globalCompositeOperation = 'source-over';
    b.shade ||= { light: mix(b.color, '#ffffff', 0.55), dark: mix(b.color, '#05060a', 0.5), deep: mix(b.color, '#05060a', 0.72) };
    c.globalAlpha = alpha;
    // head + thorax (opaque, so the curve doesn't run through the bug)
    c.fillStyle = b.shade.deep;
    c.beginPath(); c.arc(L * 0.86, 0, L * 0.3, 0, TAU); c.fill();
    c.fillStyle = b.shade.dark;
    c.beginPath(); c.ellipse(L * 0.5, 0, L * 0.26, L * 0.4, 0, 0, TAU); c.fill();
    // shell
    const g = c.createRadialGradient(L * 0.05, -L * 0.22, 0, -L * 0.15, 0, L * 0.9);
    g.addColorStop(0, b.shade.light);
    g.addColorStop(0.4, b.color);
    g.addColorStop(1, b.shade.dark);
    c.fillStyle = g;
    c.beginPath(); c.ellipse(-L * 0.18, 0, L * 0.72, L * 0.58, 0, 0, TAU); c.fill();
    c.globalAlpha = 1;
    // elytra split + spots
    c.strokeStyle = rgba('#05060a', 0.5 * alpha);
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(L * 0.5, 0); c.lineTo(-L * 0.88, 0); c.stroke();
    if (b.spots) {
      c.fillStyle = rgba('#05060a', 0.4 * alpha);
      for (const [dx, dy] of [[-0.05, -0.3], [-0.5, 0.26], [0.12, 0.3], [-0.55, -0.22]]) {
        c.beginPath(); c.arc(dx * L, dy * L, L * 0.11, 0, TAU); c.fill();
      }
    }
    // shine
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = rgba('#ffffff', 0.32 * alpha);
    c.beginPath(); c.ellipse(-L * 0.05, -L * 0.3, L * 0.3, L * 0.1, -0.15, 0, TAU); c.fill();
    c.restore();
  }

  function squash(b, reason = 'squash') {
    if (b.state !== 'alive') return;
    b.state = 'squashed';
    b.squashT = 0;
    squashed++;
    const p = plane.worldToScreen(b.x, b.y);
    if (!reduced()) {
      const k = Math.min(14, CAP.sparks - sparks.length);
      for (let i = 0; i < k; i++) {
        const a = rand(0, TAU), v = rand(60, 260);
        sparks.push({
          kind: 'dot', x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0, drag: 5.5,
          age: 0, life: rand(0.35, 0.75), size: rand(1, 2.2), color: Math.random() < 0.3 ? '#ffffff' : b.color, rot: 0, vr: 0,
        });
      }
      if (texts.length < CAP.texts) texts.push({ x: p.x + rand(-6, 6), y: p.y - 14, age: 0, life: 0.9, text: pick(SPLAT_WORDS), color: b.color });
    }
    notify(reason);
  }

  function squashAll() {
    let n = 0;
    for (const b of bugs) if (b.state === 'alive') { b.delay = 0; squash(b, 'fix'); n++; }
    return n;
  }

  // ---- butterflies ---------------------------------------------------------------------
  function butterflies(n = 9) {
    if (reduced()) return 0;
    n = Math.max(0, Math.min(n | 0, CAP.flies - flies.length));
    if (!n) return 0;
    ensureOverlay();
    const w = W(), h = H();
    for (let i = 0; i < n; i++) {
      const edge = Math.floor(Math.random() * 4);
      const start = [
        { x: rand(0, w), y: -30 }, { x: w + 30, y: rand(0, h) }, { x: rand(0, w), y: h + 30 }, { x: -30, y: rand(0, h) },
      ][edge];
      const exitEdge = (edge + 1 + Math.floor(Math.random() * 3)) % 4;
      const exit = [
        { x: rand(0, w), y: -120 }, { x: w + 120, y: rand(0, h) }, { x: rand(0, w), y: h + 120 }, { x: -120, y: rand(0, h) },
      ][exitEdge];
      const [c1, c2] = pick(WING_PAIRS);
      flies.push({
        x: start.x, y: start.y, vx: 0, vy: 0, heading: rand(0, TAU),
        ax: rand(w * 0.18, w * 0.82), ay: rand(h * 0.2, h * 0.75), exit,
        phase: rand(0, TAU), glide: 0, size: rand(9.5, 14.5), c1, c2,
        age: -i * 0.18, life: rand(9, 13), trail: [], seed: rand(0, 100), grad: null,
        k1: rand(0.5, 0.9), k2: rand(0.6, 1.1), A: rand(w * 0.08, w * 0.2), B: rand(h * 0.08, h * 0.18),
      });
    }
    return n;
  }

  function updateFly(f, dt, w, h) {
    f.age += dt;
    if (f.age < 0) return true;
    const t = f.age;
    let tx, ty;
    const leaving = t > f.life;
    if (leaving) { tx = f.exit.x; ty = f.exit.y; }
    else {
      f.ax += Math.sin(t * 0.21 + f.seed) * 14 * dt;
      f.ay += Math.cos(t * 0.17 + f.seed) * 10 * dt;
      tx = f.ax + Math.sin(t * f.k1 + f.seed) * f.A + Math.sin(t * 2.1 + f.seed * 3) * f.A * 0.25;
      ty = f.ay + Math.cos(t * f.k2 + f.seed * 2) * f.B + Math.sin(t * 2.7 + f.seed) * f.B * 0.3;
    }
    const pull = leaving ? 1.6 : 1.1;
    f.vx += ((tx - f.x) * pull - f.vx * 1.2) * dt;
    f.vy += ((ty - f.y) * pull - f.vy * 1.2) * dt;
    // each wing stroke gives a little lift: the bobbing is the whole charm
    if (f.glide <= 0) f.vy += -Math.max(0, Math.sin(f.phase)) * 260 * dt + 70 * dt;
    const sp = Math.hypot(f.vx, f.vy), max = leaving ? 320 : 220;
    if (sp > max) { f.vx *= max / sp; f.vy *= max / sp; }
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (sp > 4) f.heading += angDiff(Math.atan2(f.vy, f.vx), f.heading) * Math.min(1, dt * 5);
    if (f.glide > 0) { f.glide -= dt; f.phase += dt * 3; }
    else {
      f.phase += dt * TAU * 8.5;
      if (Math.random() < dt * 0.35) f.glide = rand(0.35, 0.8);
    }
    f.trail.push(f.x, f.y);
    if (f.trail.length > 52) f.trail.splice(0, 2);
    if (Math.random() < dt * 7 && sparks.length < CAP.sparks) {
      sparks.push({ kind: 'dot', x: f.x + rand(-3, 3), y: f.y + rand(-3, 3), vx: rand(-12, 12), vy: rand(-6, 14), g: 22, drag: 0.8,
        age: 0, life: rand(0.6, 1.2), size: rand(0.8, 1.6), color: Math.random() < 0.5 ? f.c1 : f.c2, rot: 0, vr: 0 });
    }
    const off = f.x < -100 || f.x > w + 100 || f.y < -100 || f.y > h + 100;
    return !(leaving && off) && t < f.life + 12;
  }

  function wingPaths(c, s) {
    c.beginPath(); // upper (forewing)
    c.moveTo(0, -s * 0.15);
    c.bezierCurveTo(s * 0.3, -s * 1.25, s * 1.4, -s * 1.3, s * 1.18, -s * 0.38);
    c.bezierCurveTo(s * 1.06, -s * 0.06, s * 0.45, s * 0.05, 0, s * 0.06);
    c.moveTo(0, s * 0.06); // lower (hindwing)
    c.bezierCurveTo(s * 0.78, 0, s * 1.0, s * 0.58, s * 0.62, s * 0.92);
    c.bezierCurveTo(s * 0.36, s * 1.12, s * 0.1, s * 0.62, 0, s * 0.36);
  }

  function drawFly(c, f, t) {
    if (f.age < 0) return;
    const fade = clamp(f.age / 0.5, 0, 1);
    c.globalCompositeOperation = 'lighter';
    // trail
    const tr = f.trail, n = tr.length / 2;
    c.lineCap = 'round';
    for (let i = 1; i < n; i++) {
      const k = i / n;
      c.strokeStyle = rgba(f.c1, k * k * 0.3 * fade);
      c.lineWidth = 0.6 + 2.4 * k;
      c.beginPath(); c.moveTo(tr[i * 2 - 2], tr[i * 2 - 1]); c.lineTo(tr[i * 2], tr[i * 2 + 1]); c.stroke();
    }
    const s = f.size;
    blob(c, f.c1, f.x, f.y, s * 3.2, 0.32 * fade);
    c.save();
    c.translate(f.x, f.y);
    c.rotate(f.heading + Math.PI / 2);
    if (!f.grad) {
      f.grad = c.createRadialGradient(0, 0, 0, 0, 0, s * 1.45);
      f.grad.addColorStop(0, rgba(f.c1, 0.95));
      f.grad.addColorStop(0.5, rgba(f.c2, 0.6));
      f.grad.addColorStop(1, rgba(f.c2, 0.1));
    }
    const open = f.glide > 0 ? 0.9 + 0.06 * Math.sin(t * 4) : 0.14 + 0.86 * Math.abs(Math.cos(f.phase * 0.5));
    c.globalAlpha = fade;
    for (const side of [1, -1]) {
      c.save();
      c.scale(side * open, 1);
      wingPaths(c, s);
      c.fillStyle = f.grad;
      c.fill();
      c.strokeStyle = rgba(f.c2, 0.9);
      c.lineWidth = 0.9 / Math.max(open, 0.3);
      c.stroke();
      c.fillStyle = rgba('#ffffff', 0.55);
      c.beginPath(); c.arc(s * 0.72, -s * 0.62, s * 0.11, 0, TAU); c.fill();
      c.restore();
    }
    // body + antennae
    c.fillStyle = rgba('#ffffff', 0.85);
    c.beginPath(); c.ellipse(0, s * 0.12, s * 0.09, s * 0.56, 0, 0, TAU); c.fill();
    c.beginPath(); c.arc(0, -s * 0.5, s * 0.13, 0, TAU); c.fill();
    c.strokeStyle = rgba('#ffffff', 0.6);
    c.lineWidth = 0.8;
    c.beginPath();
    c.moveTo(0, -s * 0.55); c.quadraticCurveTo(s * 0.12, -s * 0.9, s * 0.32, -s * 1.08);
    c.moveTo(0, -s * 0.55); c.quadraticCurveTo(-s * 0.12, -s * 0.9, -s * 0.32, -s * 1.08);
    c.stroke();
    c.globalAlpha = 1;
    c.restore();
  }

  // ---- confetti (glowing sparks with gravity) --------------------------------------------
  function confetti(n = 120) {
    if (reduced()) return 0;
    n = Math.max(0, Math.min(n | 0, CAP.sparks - sparks.length));
    if (!n) return 0;
    ensureOverlay();
    const w = W(), h = H();
    const k = h / 900;
    const vScale = Math.sqrt(Math.max(0.35, k));
    for (let i = 0; i < n; i++) {
      const left = i % 2 === 0;
      const ox = left ? w * 0.03 : w * 0.97, oy = h + 6;
      const spread = rand(0.06, 0.5);
      const a = -Math.PI / 2 + (left ? spread : -spread);
      const flake = Math.random() < 0.38;
      const v = rand(1250, 2050) * vScale * (flake ? 0.9 : 1);
      sparks.push({
        kind: flake ? 'flake' : 'streak',
        x: ox + rand(-8, 8), y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        g: (flake ? 850 : 1250) * k, drag: flake ? 1.5 : 0.7,
        age: -rand(0, 0.18), life: rand(2.2, 3.6), size: flake ? rand(2.6, 4.4) : rand(1.1, 1.8),
        color: pick(PALETTE), rot: rand(0, TAU), vr: rand(-9, 9),
      });
    }
    return n;
  }

  function updateSpark(p, dt, h) {
    p.age += dt;
    if (p.age < 0) return true;
    const d = Math.exp(-p.drag * dt);
    p.vx *= d; p.vy *= d;
    p.vy += p.g * dt;
    if (p.kind === 'flake') { p.vx += Math.sin(p.age * 5 + p.rot) * 60 * dt; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.rot += p.vr * dt;
    return p.age < p.life && !(p.y > h + 40 && p.vy > 0);
  }

  function drawSpark(c, p, t) {
    if (p.age < 0) return;
    const lifeK = p.age / p.life;
    const a = 1 - clamp((lifeK - 0.62) / 0.38, 0, 1);
    if (a <= 0) return;
    if (p.kind === 'streak') {
      const len = Math.max(3, Math.min(26, Math.hypot(p.vx, p.vy) * 0.028));
      const sp = Math.hypot(p.vx, p.vy) || 1;
      const ex = p.x - (p.vx / sp) * len, ey = p.y - (p.vy / sp) * len;
      c.strokeStyle = rgba(p.color, 0.22 * a);
      c.lineWidth = 4;
      c.beginPath(); c.moveTo(ex, ey); c.lineTo(p.x, p.y); c.stroke();
      c.strokeStyle = rgba(p.color, a);
      c.lineWidth = p.size;
      c.beginPath(); c.moveTo(ex, ey); c.lineTo(p.x, p.y); c.stroke();
      c.fillStyle = rgba('#ffffff', 0.8 * a);
      c.fillRect(p.x - 0.7, p.y - 0.7, 1.4, 1.4);
    } else if (p.kind === 'flake') {
      blob(c, p.color, p.x, p.y, p.size * 3.2, 0.3 * a);
      c.save();
      c.translate(p.x, p.y);
      c.rotate(p.rot);
      c.scale(1, Math.cos(p.age * 7 + p.rot));
      c.fillStyle = rgba(p.color, 0.95 * a);
      c.fillRect(-p.size, -p.size * 0.45, p.size * 2, p.size * 0.9);
      c.restore();
    } else {
      const tw = 0.75 + 0.25 * Math.sin(t * 20 + p.x);
      blob(c, p.color, p.x, p.y, p.size * 4, a * tw);
    }
  }

  // ---- frame ------------------------------------------------------------------------------
  function draw(c) {
    const tNow = now();
    const dt = Math.min(0.05, Math.max(0, (tNow - last) / 1000));
    last = tNow;
    if (!bugs.length && !flies.length && !sparks.length && !texts.length) return;
    const t = tNow / 1000;
    const w = W(), h = H(), s = scale();
    c.save();
    c.globalAlpha = 1;

    // sparks under everything else
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    for (let i = sparks.length - 1; i >= 0; i--) {
      if (!updateSpark(sparks[i], dt, h)) { sparks[i] = sparks[sparks.length - 1]; sparks.pop(); }
    }
    for (const p of sparks) drawSpark(c, p, t);

    // bugs
    for (const b of bugs) updateBug(b, dt, s, w, h);
    for (const b of bugs) drawBug(c, b, t);
    for (let i = bugs.length - 1; i >= 0; i--) if (bugs[i].state === 'gone') bugs.splice(i, 1);

    // butterflies on top
    for (let i = flies.length - 1; i >= 0; i--) if (!updateFly(flies[i], dt, w, h)) flies.splice(i, 1);
    for (const f of flies) drawFly(c, f, t);

    // "splat" labels
    if (texts.length) {
      c.globalCompositeOperation = 'lighter';
      c.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (let i = texts.length - 1; i >= 0; i--) {
        const x = texts[i];
        x.age += dt;
        if (x.age > x.life) { texts.splice(i, 1); continue; }
        const k = x.age / x.life;
        const yy = x.y - 22 * (1 - (1 - k) ** 2);
        c.fillStyle = rgba(x.color, 0.35 * (1 - k));
        c.fillText(x.text, x.x, yy + 0.5);
        c.fillStyle = rgba('#ffffff', 0.95 * (1 - k));
        c.fillText(x.text, x.x, yy);
      }
    }
    c.restore();
  }

  // ---- input: squash on tap ------------------------------------------------------------------
  plane.on?.('tap', (world) => {
    const wp = world?.world || world;
    if (!wp || !Number.isFinite(wp.x) || !bugs.length) return;
    const tp = plane.worldToScreen(wp.x, wp.y);
    let best = null, bd = HIT_RADIUS * HIT_RADIUS;
    for (const b of bugs) {
      if (b.state !== 'alive' || b.delay > 0) continue;
      const p = plane.worldToScreen(b.x, b.y);
      const d = (p.x - tp.x) ** 2 + (p.y - tp.y) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    if (best) {
      squash(best, 'squash');
      world.handled = true; // a squash is not the first half of a double-click zoom
    }
  });

  function stopAll() {
    bugs.length = 0; flies.length = 0; sparks.length = 0; texts.length = 0;
    squashed = 0;
    notify('stop');
  }

  return {
    spawnBugs,
    butterflies,
    confetti,
    stopAll,
    squashAll,
    bugCount: aliveBugs,
    onBugsChanged(fn) { if (typeof fn === 'function') listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
  };
}

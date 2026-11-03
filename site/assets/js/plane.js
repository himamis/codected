// plane.js — the glowing, infinite, pannable coordinate plane that is also a map.
// A love letter to GeoGebra (grid, axes, curves) and Mapplic (pins, route, minimap).
// Zero dependencies. Canvas 2D, layered strokes with 'lighter' compositing instead of shadowBlur.

import { REF_SCALE, PLACES, TOUR, WORLD_BOUNDS } from './content.js';

const S_MIN = 6;
const S_MAX = 400;
const CARD_HIDE_K = 0.42; // below this card scale, cards fade out and only pins remain
const CARD_FULL_K = 0.54;
const CAMERA_LIMIT = 600; // world units; the plane is infinite, your patience is not
const CURVE_FRAME_BUDGET = 40000; // function evaluations per frame, shared by all curves
const DPR_CAP = 2;
const TAU = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => {
  const c1 = 1.55, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/* ------------------------------------------------------------------------ */
/* colours                                                                  */
/* ------------------------------------------------------------------------ */

const FALLBACK_RGB = [61, 245, 255];
const colorCache = new Map();
let colorProbe = null;

function parseColor(c) {
  if (Array.isArray(c)) return c;
  if (c == null) return FALLBACK_RGB;
  const key = String(c).trim();
  const hit = colorCache.get(key);
  if (hit) return hit;
  let out = null;
  if (key[0] === '#') {
    let h = key.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((ch) => ch + ch).join('');
    const n = parseInt(h.slice(0, 6), 16);
    if (!Number.isNaN(n)) out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    const m = key.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) out = p.slice(0, 3);
    } else if (typeof document !== 'undefined') {
      // named colours, hsl(), whatever: let the browser normalise it
      colorProbe ||= document.createElement('canvas').getContext('2d');
      colorProbe.fillStyle = '#010203';
      colorProbe.fillStyle = key;
      const norm = colorProbe.fillStyle;
      if (norm !== key && norm !== '#010203') out = parseColor(norm);
    }
  }
  out ||= FALLBACK_RGB;
  colorCache.set(key, out);
  return out;
}

function rotateHue([r, g, b], deg) {
  if (!deg) return [r, g, b];
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  h = (((h + deg / 360) % 1) + 1) % 1;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const tint = (c, t) => [lerp(c[0], 255, t), lerp(c[1], 255, t), lerp(c[2], 255, t)];

/* ------------------------------------------------------------------------ */
/* number ladder (1, 2, 5 × 10^k) — GeoGebra-style grid spacing             */
/* ------------------------------------------------------------------------ */

function ladderAtLeast(v) {
  const k = Math.floor(Math.log10(v));
  const base = Math.pow(10, k);
  for (const m of [1, 2, 5, 10]) if (m * base >= v * (1 - 1e-9)) return m * base;
  return 10 * base;
}
function ladderNext(L) {
  const k = Math.floor(Math.log10(L) + 1e-9);
  const base = Math.pow(10, k);
  const m = Math.round(L / base);
  return m === 1 ? 2 * base : m === 2 ? 5 * base : 10 * base;
}
function formatTick(v, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  let s = v.toFixed(Math.min(6, decimals));
  if (/^-0(\.0+)?$/.test(s)) s = '0';
  return s.replace('-', '−');
}

/* ------------------------------------------------------------------------ */
/* van Wijk & Nuij smooth zoom+pan ("zoom out, pan, zoom in")                */
/* ------------------------------------------------------------------------ */

function interpolateZoom(p0, p1, rho = 1.35) {
  const [ux0, uy0, w0] = p0;
  const [ux1, uy1, w1] = p1;
  const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
  const rho2 = rho * rho, rho4 = rho2 * rho2;
  let S, fn;
  if (d2 < 1e-12) {
    S = Math.log(w1 / w0) / rho;
    fn = (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)];
  } else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / rho;
    const coshr0 = Math.cosh(r0), sinhr0 = Math.sinh(r0);
    fn = (t) => {
      const s = t * S;
      const u = (w0 / (rho2 * d1)) * (coshr0 * Math.tanh(rho * s + r0) - sinhr0);
      return [ux0 + u * dx, uy0 + u * dy, (w0 * coshr0) / Math.cosh(rho * s + r0)];
    };
  }
  return { fn, S: Math.abs(S) };
}

/* ------------------------------------------------------------------------ */
/* centripetal Catmull-Rom (no loops, no cusps, no drama)                   */
/* ------------------------------------------------------------------------ */

function catmullRomSegment(p0, p1, p2, p3, n, alpha = 0.5) {
  const knot = (ti, a, b) => ti + Math.max(1e-4, Math.pow(Math.hypot(b.x - a.x, b.y - a.y), alpha));
  const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
  const mix = (a, b, ta, tb, t) => {
    const u = (t - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = t1 + ((t2 - t1) * i) / n;
    const A1 = mix(p0, p1, t0, t1, t), A2 = mix(p1, p2, t1, t2, t), A3 = mix(p2, p3, t2, t3, t);
    const B1 = mix(A1, A2, t0, t2, t), B2 = mix(A2, A3, t1, t3, t);
    pts.push(mix(B1, B2, t1, t2, t));
  }
  return pts;
}

/* ------------------------------------------------------------------------ */
/* the pin shape (css px, tip at origin)                                    */
/* ------------------------------------------------------------------------ */

const PIN_R = 9.5;
const PIN_D = 23; // tip → head centre
function makePinPath() {
  const p = new Path2D();
  const a = Math.asin(PIN_R / PIN_D);
  const beta = Math.PI / 2 - a;
  p.moveTo(0, 0);
  p.lineTo(PIN_R * Math.sin(beta), -PIN_D + PIN_R * Math.cos(beta));
  p.arc(0, -PIN_D, PIN_R, a, Math.PI - a, true);
  p.closePath();
  return p;
}

const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [data-no-pan]';
const TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const isTextEntry = (el) => !!el?.closest?.(TEXT_ENTRY);
const ARROW_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 6.9h8.2L6.6 3.8l1.5-1.5L13.8 8l-5.7 5.7-1.5-1.5 3.1-3.1H1.5z"/></svg>';

/* ======================================================================== */

export class Plane {
  constructor({
    canvas,
    worldEl,
    minimapCanvas,
    places = PLACES,
    reducedMotion = false,
    tour = TOUR,
    bounds = WORLD_BOUNDS,
    edgeArrowsEl = document.getElementById('edge-arrows'),
    coordsEl = document.getElementById('coords'),
  } = {}) {
    if (!canvas) throw new Error('Plane needs a canvas. It is, after all, a plane.');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.worldEl = worldEl || null;
    this.minimapCanvas = minimapCanvas || null;
    this.mctx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
    this.edgeArrowsEl = edgeArrowsEl || null;
    this.coordsEl = coordsEl || null;
    this.places = places;
    this.tour = tour.filter((id) => places.some((p) => p.id === id));
    this.bounds = bounds;
    this.reducedMotion = !!reducedMotion;

    this.camera = { x: 0, y: 0, s: REF_SCALE };
    this.objects = new Map();
    this.effects = { jitter: 0, hue: 0, timeScale: 1, frozen: false };
    this.time = 0; // drives `t` in functions
    this.clock = 0; // real seconds since start (animations, overlays)
    this.routeVisible = true;
    this.currentPlace = null;

    this.W = 1; this.H = 1; this.dpr = 1;
    this._listeners = new Map();
    this._overlays = [];
    this._paused = false;
    this._raf = 0;
    this._lastNow = 0;
    this._frame = 0;
    this._ox = 0; this._oy = 0;

    // motion state
    this._flight = null;
    this._zoomAnim = null; // { logTarget, ax, ay }
    this._glide = null; // { x, y } world target (minimap)
    this._vel = { x: 0, y: 0 }; // inertia, screen px/s
    this._keys = new Set();
    this._keyVel = { x: 0, y: 0 };
    this._lastZoomAt = -1;
    this._parkedAt = null;
    this._userMoved = false;
    this._lastZoomCall = { t: 0, f: 0 };

    // pointer state
    this._pointers = new Map();
    this._gesture = null;
    this._suppressClick = false;
    this._lastTap = null;
    this._hover = { sx: 0, sy: 0, on: false, pin: null, glow: 0 };
    this._wheel = { last: 0, mode: 'zoom' };

    this._pinPath = makePinPath();
    this._pinState = new Map(places.map((p, i) => [p.id, { hover: 0, idx: i }]));
    this._intro = { start: -1 };
    this._hud = [];
    this._free = { l: 0, t: 0, r: 1, b: 1 };

    this._buildRoute();
    this._setupCards();
    this._setupEdgeArrows();
    this._injectStyles();
    this._bind();
    this.resize();

    // initial camera: deep link or hello, fitted to the screen
    const fromHash = this._placeFromHash();
    const startId = fromHash || 'hello';
    const target = this._placeCamera(startId);
    this.currentPlace = startId;
    if (this.reducedMotion) {
      Object.assign(this.camera, target);
      this._parkedAt = startId;
      this._intro.start = -10;
    } else {
      Object.assign(this.camera, { x: target.x, y: target.y - 1.5, s: target.s * 0.42 });
      this._startIntro(startId);
    }
    this._requestFrame();
  }

  /* ---------------------------------------------------------------------- */
  /* public API                                                              */
  /* ---------------------------------------------------------------------- */

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }
  _emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (err) { console.error(`[plane] '${event}' listener failed`, err); }
    }
  }

  get k() { return this.camera.s / REF_SCALE; }

  addObject(obj) {
    if (!obj) return null;
    const o = { visible: true, ...obj };
    if (o.id == null) o.id = `obj-${(this._objSeq = (this._objSeq || 0) + 1)}`;
    if (o.kind === 'route') this.routeVisible = o.visible !== false;
    this.objects.set(o.id, o);
    this._emit('change', { type: 'add', id: o.id });
    return o;
  }
  removeObject(id) {
    const o = this.objects.get(id);
    const had = this.objects.delete(id);
    if (o?.kind === 'route') this.routeVisible = false;
    if (had) this._emit('change', { type: 'remove', id });
    return had;
  }
  setVisible(id, visible) {
    const o = this.objects.get(id);
    if (o) o.visible = !!visible;
    if (o?.kind === 'route') this.routeVisible = !!visible;
    this._emit('change', { type: 'visible', id, visible: !!visible });
  }
  /** Removes everything a visitor typed. Keeps objects flagged builtin / locked / persistent / default, and the route. */
  clearUserObjects() {
    const removed = [];
    for (const [id, o] of this.objects) {
      if (o.kind === 'route' || o.builtin || o.locked || o.persistent || o.default || o.user === false) continue;
      this.objects.delete(id);
      removed.push(id);
    }
    if (removed.length) this._emit('change', { type: 'clear', ids: removed });
    return removed;
  }

  worldToScreen(x, y) {
    const { camera: c } = this;
    return { x: this.W / 2 + (x - c.x) * c.s, y: this.H / 2 - (y - c.y) * c.s };
  }
  screenToWorld(px, py) {
    const { camera: c } = this;
    return { x: c.x + (px - this.W / 2) / c.s, y: c.y - (py - this.H / 2) / c.s };
  }

  /** Smoothly fly the camera. Resolves true on arrival, false if interrupted. */
  flyTo(target, { duration } = {}) {
    const to = {
      x: clamp(Number.isFinite(target?.x) ? target.x : this.camera.x, -CAMERA_LIMIT, CAMERA_LIMIT),
      y: clamp(Number.isFinite(target?.y) ? target.y : this.camera.y, -CAMERA_LIMIT, CAMERA_LIMIT),
      s: clamp(Number.isFinite(target?.s) ? target.s : this.camera.s, S_MIN, S_MAX),
    };
    const f = this._flight;
    if (f && Math.abs(f.to.x - to.x) < 1e-3 && Math.abs(f.to.y - to.y) < 1e-3 && Math.abs(f.to.s - to.s) < 1e-3) {
      return f.promise; // same trip already booked
    }
    this._cancelFlight();
    this._stopMotion();
    this._parkedAt = null; // flyToPlace re-parks on arrival
    if (this._intro.flying) this._intro.flying = false; // the user booked a trip: the intro yields
    const c = this.camera;
    const already = Math.hypot(c.x - to.x, c.y - to.y) * to.s < 0.5 && Math.abs(Math.log(c.s / to.s)) < 0.002;
    if (this.reducedMotion || duration === 0 || already) {
      Object.assign(this.camera, to);
      this._requestFrame();
      return Promise.resolve(true);
    }
    const view = Math.min(this.W, this.H);
    const { fn, S } = interpolateZoom(
      [this.camera.x, this.camera.y, view / this.camera.s],
      [to.x, to.y, view / to.s],
    );
    const dur = Number.isFinite(duration) ? Math.max(1, duration) : clamp(520 + S * 340, 560, 1700);
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this._flight = { fn, to, dur, t0: performance.now(), resolve, promise, view };
    this._requestFrame();
    return promise;
  }

  /** Fly to a place by id. Updates the URL hash and emits 'arrive'. */
  flyToPlace(id, opts = {}) {
    const place = this.placeById(id);
    if (!place) return Promise.resolve(false);
    const target = this._placeCamera(id);
    this.currentPlace = id;
    this._setHash(id);
    this._markNav(id);
    const trip = this.flyTo(target, opts);
    if (this._flight) this._flight.placeId = id; // lets a resize mid-flight re-aim at the right framing
    return trip.then((ok) => {
      if (ok) this._arrive(id);
      return ok;
    });
  }

  home(opts) { return this.flyToPlace('hello', opts); }

  /** Fly to the next (dir = 1) or previous (dir = -1) stop on the tour. */
  next(dir = 1) {
    const cur = this._parkedAt || this._nearestPlace()?.id || this.currentPlace || this.tour[0];
    let i = this.tour.indexOf(cur);
    if (i < 0) i = 0;
    const n = this.tour.length;
    return this.flyToPlace(this.tour[(((i + dir) % n) + n) % n]);
  }

  /** Zoom by a factor around a screen point (default: the centre). Smooth unless reduced motion. */
  zoomBy(factor, sx = this.W / 2, sy = this.H / 2) {
    if (!(factor > 0)) return;
    // de-dupe: two wired click handlers calling this in the same breath should not double-zoom
    const now = performance.now();
    if (now - this._lastZoomCall.t < 40 && this._lastZoomCall.f === factor) return;
    this._lastZoomCall = { t: now, f: factor };
    this._zoomSmooth(factor, sx, sy);
  }

  /** Pan by screen pixels. */
  panBy(dx, dy) {
    this.camera.x += dx / this.camera.s;
    this.camera.y -= dy / this.camera.s;
    this._clampCamera();
    this._requestFrame();
  }

  placeById(id) { return this.places.find((p) => p.id === id) || null; }

  /** Draw something every frame after the curves: drawFn(ctx, plane, dt, clock). Returns a remover. */
  addOverlay(drawFn) {
    this._overlays.push(drawFn);
    return () => {
      const i = this._overlays.indexOf(drawFn);
      if (i >= 0) this._overlays.splice(i, 1);
    };
  }

  pause(reason = 'api') { this._setPaused(true, reason); }
  resume(reason = 'api') { this._setPaused(false, reason); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width) || window.innerWidth);
    const H = Math.max(1, Math.round(r.height) || window.innerHeight);
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    const sizeChanged = W !== this.W || H !== this.H;
    if (sizeChanged || dpr !== this.dpr) {
      this.W = W; this.H = H; this.dpr = dpr;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    this._canvasLeft = r.left || 0;
    this._canvasTop = r.top || 0;
    this._readSafeArea();
    if (this.minimapCanvas) {
      const m = this.minimapCanvas;
      const mw = m.clientWidth, mh = m.clientHeight;
      if (mw && mh && (m.width !== Math.round(mw * dpr) || m.height !== Math.round(mh * dpr))) {
        m.width = Math.round(mw * dpr);
        m.height = Math.round(mh * dpr);
      }
      this._mmW = mw; this._mmH = mh;
    }
    this._measureHud();
    this._measureCards();
    // a parked camera follows the viewport (rotation, window resize) so the card stays framed
    if (sizeChanged && this._parkedAt && !this._flight && this._intro.done !== false) {
      Object.assign(this.camera, this._placeCamera(this._parkedAt));
    }
    // a flight to a place that's still in the air re-aims at the framing for the new viewport
    if (sizeChanged) this._reaimFlight();
    this._requestFrame();
  }

  /** env(safe-area-inset-*) can't be read from JS directly, so a hidden probe element carries it as padding. */
  _readSafeArea() {
    const el = document.getElementById('safe-probe');
    if (!el) { this._safe = { t: 0, r: 0, b: 0, l: 0 }; return; }
    const cs = getComputedStyle(el);
    const px = (v) => parseFloat(v) || 0;
    this._safe = { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
  }

  /** Keep the current flight (and its promise) but point it at the place's framing for the current viewport. */
  _reaimFlight() {
    const f = this._flight;
    if (!f?.placeId) return;
    const to = this._placeCamera(f.placeId);
    if (Math.abs(to.x - f.to.x) < 1e-3 && Math.abs(to.y - f.to.y) < 1e-3 && Math.abs(to.s - f.to.s) < 1e-3) return;
    const now = performance.now();
    const c = this.camera;
    const view = Math.min(this.W, this.H);
    const { fn } = interpolateZoom([c.x, c.y, view / c.s], [to.x, to.y, view / to.s]);
    Object.assign(f, { fn, to, view, t0: now, dur: Math.max(280, f.dur - (now - f.t0)) });
  }

  destroy() {
    this._setPaused(true, 'destroy');
    for (const off of this._unbind || []) off();
    this._ro?.disconnect();
    this._mo?.disconnect();
    this._styleEl?.remove();
  }

  /* ---------------------------------------------------------------------- */
  /* places & camera helpers                                                 */
  /* ---------------------------------------------------------------------- */

  _placeFromHash() {
    let raw = (location.hash || '').slice(1);
    try { raw = decodeURIComponent(raw); } catch { return null; } // '#100%' is not a place, and not a crash either
    const id = raw.toLowerCase();
    return this.placeById(id) ? id : null;
  }

  _setHash(id) {
    try {
      const url = id === 'hello' ? location.pathname + location.search : `#${id}`;
      if ((id === 'hello' && !location.hash) || location.hash === `#${id}`) return;
      history.replaceState(history.state, '', url);
    } catch { /* sandboxed iframes, file://, etc. */ }
  }

  _markNav(id) {
    for (const b of document.querySelectorAll('.place-btn[data-place]')) {
      if (b.dataset.place === id) b.setAttribute('aria-current', 'location');
      else b.removeAttribute('aria-current');
    }
  }

  _arrive(id) {
    this._parkedAt = id;
    this.currentPlace = id;
    this._markNav(id);
    this._emit('arrive', id);
  }

  _nearestPlace() {
    let best = null, bd = Infinity;
    for (const p of this.places) {
      const d = Math.hypot(p.x - this.camera.x, p.y - this.camera.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  _cardSize(id) {
    const c = this._cards.get(id);
    return { w: c?.w || 380, h: c?.h || 340 };
  }

  /** Camera that frames a place's card + pin inside the free (non-HUD) part of the screen. */
  _placeCamera(id) {
    const p = this.placeById(id);
    if (!p) return { ...this.camera };
    const { w, h } = this._cardSize(id);
    const f = this._free;
    const fw = Math.max(120, f.r - f.l - 32);
    const fh = Math.max(120, f.b - f.t - 28);
    const pinBelowPx = 30; // pin label under the tip
    const fitH = (bottom) => (Math.max(120, bottom - f.t - 28) - pinBelowPx) / (h / REF_SCALE + 1);
    let s = Math.min(REF_SCALE, (fw * REF_SCALE) / w, (fh - pinBelowPx) / (h / REF_SCALE + 1));
    s = clamp(s, 12, S_MAX);
    // tablets: if the card can't sit beside the desktop algebra panel at this scale, shrink it until it can
    const alg = this._hud.find((r) => r.id === 'algebra' && r.side === 'left');
    if (alg) {
      const avail = this.W - alg.right - 14 - 16;
      if ((w / REF_SCALE) * s > avail) s = clamp((avail * REF_SCALE) / w, 12, s);
    }
    // horizontal placement at a given scale: centred, or nudged right of the desktop algebra panel
    const span = (sc) => {
      const hw = ((w / REF_SCALE) * sc) / 2;
      let cx = (f.l + f.r) / 2;
      if (alg && this.W / 2 - hw < alg.right + 14) {
        cx = Math.min(Math.max(cx, alg.right + 14 + hw), this.W - 16 - hw);
        if (cx < this.W / 2) cx = this.W / 2;
      }
      return { l: cx - hw, r: cx + hw, cx };
    };
    // the minimap / zoom corner is an obstacle too (phones excluded: there it's a home button above the sheet)
    let fb = f.b;
    const br = this._hud.find((r) => r.id === 'hud-br');
    const sheet = this._hud.some((r) => r.id === 'algebra' && r.side === 'bottom');
    if (br && !sheet && br.top > f.t + 120) {
      const hits = (sc) => { const sp = span(sc); return br.left - 8 < sp.r && br.right + 8 > sp.l; };
      if (hits(s)) {
        const above = clamp(Math.min(s, fitH(br.top - 8)), 12, s); // keep the card (and its pin label) above it…
        let beside = s; // …or shrink just enough to clear it sideways, whichever leaves the bigger card
        while (beside > 12 && hits(beside)) beside *= 0.97;
        if (beside >= above && !hits(beside)) s = beside;
        else { s = above; fb = br.top - 8; }
      }
    }
    const { cx: fcx } = span(s);
    // vertical: centre [pin label … card top] in the free area
    const top = p.y + 1 + h / REF_SCALE;
    const bottom = p.y - pinBelowPx / s;
    const wy = (top + bottom) / 2;
    const fcy = (f.t + fb) / 2;
    return { x: p.x - (fcx - this.W / 2) / s, y: wy + (fcy - this.H / 2) / s, s };
  }

  _clampCamera() {
    const c = this.camera;
    c.x = clamp(c.x, -CAMERA_LIMIT, CAMERA_LIMIT);
    c.y = clamp(c.y, -CAMERA_LIMIT, CAMERA_LIMIT);
    c.s = clamp(c.s, S_MIN, S_MAX);
  }

  _zoomAbout(sx, sy, newS) {
    const w = this.screenToWorld(sx, sy);
    this.camera.s = clamp(newS, S_MIN, S_MAX);
    this.camera.x = w.x - (sx - this.W / 2) / this.camera.s;
    this.camera.y = w.y + (sy - this.H / 2) / this.camera.s;
    this._clampCamera();
  }

  _zoomSmooth(factor, sx, sy) {
    this._cancelFlight();
    this._glide = null;
    this._userMove();
    if (this.reducedMotion) {
      this._zoomAbout(sx, sy, this.camera.s * factor);
      this._requestFrame();
      return;
    }
    const cur = this._zoomAnim ? this._zoomAnim.logTarget : Math.log(this.camera.s);
    this._zoomAnim = {
      logTarget: clamp(cur + Math.log(factor), Math.log(S_MIN), Math.log(S_MAX)),
      ax: sx,
      ay: sy,
    };
    this._requestFrame();
  }

  _cancelFlight() {
    if (this._flight) {
      const f = this._flight;
      this._flight = null;
      f.resolve(false);
    }
  }
  _stopMotion() {
    this._zoomAnim = null;
    this._glide = null;
    this._vel.x = this._vel.y = 0;
  }
  _userMove() {
    this._parkedAt = null;
    this._userMoved = true;
    if (this._intro.flying) this._intro.flying = false;
  }

  _startIntro(id) {
    this._intro = { start: this.clock, flying: true, done: false };
    const go = () => {
      if (!this._intro.flying || this._flight) { this._intro.done = true; this._intro.flying = false; return; }
      const target = this._placeCamera(id);
      const view = Math.min(this.W, this.H);
      const { fn } = interpolateZoom([this.camera.x, this.camera.y, view / this.camera.s], [target.x, target.y, view / target.s]);
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      this._flight = { fn, to: target, dur: 1500, t0: performance.now(), resolve, promise, view, intro: true, placeId: id };
      promise.then((ok) => {
        this._intro.done = true;
        this._intro.flying = false;
        if (ok) this._arrive(id);
      });
    };
    // let fonts settle so the card is measured at its real size (but never wait long)
    let fired = false;
    const once = () => { if (!fired) { fired = true; this._measureCards(); go(); } };
    document.fonts?.ready?.then(() => setTimeout(once, 30));
    setTimeout(once, 450);
  }

  /* ---------------------------------------------------------------------- */
  /* DOM setup                                                               */
  /* ---------------------------------------------------------------------- */

  _setupCards() {
    this._cards = new Map();
    if (!this.worldEl) return;
    for (const el of this.worldEl.querySelectorAll('.card[data-place]')) {
      const id = el.dataset.place;
      if (!this.placeById(id)) continue;
      el.style.position = 'absolute';
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.transformOrigin = '50% 100%';
      el.style.touchAction = 'none';
      this._cards.set(id, { el, w: 0, h: 0, tf: '', op: -1, pe: '', wc: false, active: false });
    }
    if ('ResizeObserver' in window) {
      this._ro = new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const id = e.target.dataset?.place;
          const c = id && this._cards.get(id);
          if (!c) continue;
          const w = e.target.offsetWidth, h = e.target.offsetHeight;
          if (w && h && (w !== c.w || h !== c.h)) { c.w = w; c.h = h; changed = true; }
        }
        if (changed && this._parkedAt && !this._flight) Object.assign(this.camera, this._placeCamera(this._parkedAt));
        else if (changed) this._reaimFlight();
      });
      for (const c of this._cards.values()) this._ro.observe(c.el);
    }
  }

  _measureCards() {
    for (const c of this._cards.values()) {
      const w = c.el.offsetWidth, h = c.el.offsetHeight;
      if (w && h) { c.w = w; c.h = h; }
    }
  }

  _measureHud() {
    const W = this.W, H = this.H;
    const out = [];
    let top = 0, bottom = H, left = 0, right = W;
    for (const id of ['hud-top', 'algebra', 'hud-br']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const rect = { id, left: r.left, top: r.top, right: r.right, bottom: r.bottom, side: '' };
      if (id === 'hud-top' && r.top < 40 && r.height < H * 0.3) top = Math.max(top, r.bottom + 6);
      if (id === 'algebra') {
        if (r.top > H * 0.4 && r.width > W * 0.6) {
          rect.side = 'bottom';
          bottom = Math.min(bottom, Math.max(H * 0.6, r.top - 6));
        } else if (r.left < W * 0.25 && r.width < W * 0.5) {
          rect.side = 'left';
        }
      }
      out.push(rect);
    }
    this._hud = out;
    this._free = { l: left, t: top, r: right, b: bottom };
  }

  _setupEdgeArrows() {
    this._edges = new Map();
    const host = this.edgeArrowsEl;
    if (!host) return;
    host.replaceChildren();
    for (const p of this.places) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'edge-arrow is-hidden';
      b.dataset.place = p.id;
      b.tabIndex = -1;
      b.setAttribute('aria-label', `Go to ${p.label}`);
      b.style.setProperty('--c', p.color);
      b.innerHTML = `<span class="edge-arrow-icon" aria-hidden="true">${ARROW_SVG}</span><span class="edge-arrow-label">${p.label}</span><span class="edge-arrow-dist" aria-hidden="true"></span>`;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.flyToPlace(p.id);
      });
      host.append(b);
      this._edges.set(p.id, {
        el: b,
        icon: b.querySelector('.edge-arrow-icon'),
        dist: b.querySelector('.edge-arrow-dist'),
        shown: false,
        w: 40 + p.label.length * 7.2 + 30,
        h: 30,
        tf: '', rot: '', d: '',
        measured: false,
      });
    }
  }

  _injectStyles() {
    // Only the bits the engine needs to behave; zero specificity so main.css always wins.
    const css = `
:where(.plane-panning), :where(.plane-panning) * { cursor: grabbing !important; -webkit-user-select: none !important; user-select: none !important; }
:where(.plane-panning) #world .card { transition-property: opacity, visibility; }
:where(.plane-pin-hover) #plane { cursor: pointer; }
:where(.edge-arrow-icon) { display: inline-grid; place-items: center; width: 14px; height: 14px; transition: transform .12s linear; }
:where(.edge-arrow-icon) svg { width: 13px; height: 13px; display: block; }
:where(.edge-arrow-icon) svg path { fill: currentColor; }
.edge-arrow.is-compact { width: 32px; height: 32px; padding: 0; gap: 0; justify-content: center; }
.edge-arrow.is-compact .edge-arrow-label, .edge-arrow.is-compact .edge-arrow-dist { display: none; }
`;
    const el = document.createElement('style');
    el.dataset.owner = 'plane.js';
    el.textContent = css;
    document.head.prepend(el);
    this._styleEl = el;
  }

  /* ---------------------------------------------------------------------- */
  /* input                                                                   */
  /* ---------------------------------------------------------------------- */

  _bind() {
    const offs = (this._unbind = []);
    const listen = (target, type, fn, opts) => {
      if (!target) return;
      target.addEventListener(type, fn, opts);
      offs.push(() => target.removeEventListener(type, fn, opts));
    };

    listen(window, 'pointerdown', (e) => this._onPointerDown(e), { capture: true });
    listen(window, 'pointermove', (e) => this._onPointerMove(e), { capture: true, passive: true });
    listen(window, 'pointerup', (e) => this._onPointerUp(e, false), { capture: true });
    listen(window, 'pointercancel', (e) => this._onPointerUp(e, true), { capture: true });
    listen(window, 'click', (e) => {
      if (this._suppressClick) {
        this._suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, { capture: true });
    listen(window, 'wheel', (e) => this._onWheel(e), { passive: false });
    listen(document, 'selectstart', (e) => {
      if (this._gesture && this._inWorld(e.target?.nodeType === 1 ? e.target : e.target?.parentElement)) e.preventDefault();
    });
    listen(this.worldEl, 'dragstart', (e) => e.preventDefault());
    listen(this.canvas, 'contextmenu', (e) => { if (this._gesture?.mode === 'pan') e.preventDefault(); });

    // Safari desktop trackpad pinch
    listen(window, 'gesturestart', (e) => this._onGesture(e, 'start'), { passive: false });
    listen(window, 'gesturechange', (e) => this._onGesture(e, 'change'), { passive: false });
    listen(window, 'gestureend', (e) => this._onGesture(e, 'end'), { passive: false });

    listen(window, 'keydown', (e) => this._onKeyDown(e));
    listen(window, 'keyup', (e) => this._keys.delete(e.key));
    listen(window, 'blur', () => this._keys.clear());
    listen(document.documentElement, 'pointerleave', () => { this._hover.on = false; });

    listen(window, 'resize', () => this.resize());
    listen(window.visualViewport, 'resize', () => this.resize());
    listen(window, 'hashchange', () => {
      const id = this._placeFromHash() || ((location.hash || '#').length <= 1 ? 'hello' : null);
      if (id) this.flyToPlace(id);
    });
    listen(document, 'visibilitychange', () => this._setPaused(document.hidden, 'hidden'));

    // keyboard users tabbing into an off-screen card get flown there
    listen(this.worldEl, 'focusin', (e) => {
      const card = e.target.closest?.('.card[data-place]');
      if (!card) return;
      let visible = false;
      try { visible = e.target.matches(':focus-visible'); } catch { visible = true; }
      if (!visible) return;
      const id = card.dataset.place;
      // the browser has already scrolled the overflow:hidden #world to reveal the focus, so the DOM rect lies
      this.worldEl.scrollTop = this.worldEl.scrollLeft = 0;
      const p = this.placeById(id);
      const c = this._cards.get(id);
      const k = this.k;
      const a = this.worldToScreen(p.x, p.y + 1); // card anchor: bottom centre
      const w = (c?.w || card.offsetWidth) * k, h = (c?.h || card.offsetHeight) * k;
      const f = this._free;
      const onScreen = a.x - w / 2 >= f.l && a.x + w / 2 <= f.r && a.y - h >= f.t - 4 && a.y <= f.b;
      if (!onScreen || k < CARD_FULL_K) this.flyToPlace(id);
    });
    // focusing inside an overflow:hidden layer makes browsers "helpfully" scroll it. No.
    listen(this.worldEl, 'scroll', () => {
      if (this.worldEl.scrollTop || this.worldEl.scrollLeft) this.worldEl.scrollTop = this.worldEl.scrollLeft = 0;
    });

    // navigation affordances (de-duped by flyTo, so double-wiring elsewhere is harmless)
    listen(document, 'click', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const go = t.closest('[data-go], [data-goto], .place-btn[data-place]');
      if (go) {
        const id = go.dataset.go || go.dataset.goto || go.dataset.place;
        if (this.placeById(id)) this.flyToPlace(id);
        return;
      }
      if (t.closest('#brand, #zoom-home')) { this.home(); return; }
      if (t.closest('#zoom-in')) { this.zoomBy(1.6); return; }
      if (t.closest('#zoom-out')) { this.zoomBy(1 / 1.6); return; }
    });

    // minimap
    if (this.minimapCanvas) {
      const mm = this.minimapCanvas;
      mm.style.touchAction = 'none';
      let dragging = false;
      const toWorld = (e) => {
        const r = mm.getBoundingClientRect();
        const m = this._minimapMap();
        if (!m) return null;
        return { x: (e.clientX - r.left - m.ox) / m.k + this.bounds.minX, y: this.bounds.maxY - (e.clientY - r.top - m.oy) / m.k };
      };
      listen(mm, 'pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        const w = toWorld(e);
        if (!w) return;
        dragging = true;
        try { mm.setPointerCapture(e.pointerId); } catch { /* fine */ }
        this._cancelFlight();
        this._zoomAnim = null;
        this._vel.x = this._vel.y = 0;
        this._userMove();
        this._glide = { x: w.x, y: w.y };
        this._requestFrame();
      });
      listen(mm, 'pointermove', (e) => {
        if (!dragging) return;
        const w = toWorld(e);
        if (w) this._glide = { x: w.x, y: w.y };
      });
      const end = () => { dragging = false; };
      listen(mm, 'pointerup', end);
      listen(mm, 'pointercancel', end);
      listen(mm, 'lostpointercapture', end);
    }

    // pause in boring mode
    if ('MutationObserver' in window) {
      this._mo = new MutationObserver(() => this._setPaused(document.body.classList.contains('is-boring'), 'boring'));
      this._mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.canvas);
      if (this.minimapCanvas) ro.observe(this.minimapCanvas);
      for (const id of ['hud-top', 'algebra']) {
        const el = document.getElementById(id);
        if (el) ro.observe(el);
      }
      offs.push(() => ro.disconnect());
    }
    if (typeof matchMedia === 'function') {
      const watchDpr = () => {
        const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        const on = () => { this.resize(); watchDpr(); };
        mq.addEventListener?.('change', on, { once: true });
        offs.push(() => mq.removeEventListener?.('change', on));
      };
      watchDpr();
    }
  }

  _inWorld(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el === this.canvas) return true;
    if (this.worldEl && this.worldEl.contains(el) && el !== this.worldEl) return true;
    return el === document.body || el === document.documentElement;
  }

  _local(e) {
    return { x: e.clientX - this._canvasLeft, y: e.clientY - this._canvasTop };
  }

  _onPointerDown(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!this._inWorld(t)) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if (isTextEntry(t)) return;
    if (this._paused) return;

    const p = this._local(e);
    const interactive = !!(t !== this.canvas && t.closest(INTERACTIVE));
    this._pointers.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y, t0: performance.now(), type: e.pointerType });

    // grabbing a moving map stops it
    this._vel.x = this._vel.y = 0;
    this._zoomAnim = null;
    this._glide = null;
    if (e.pointerType === 'mouse' && e.button === 1) e.preventDefault();

    if (this._pointers.size === 1) {
      this._gesture = {
        mode: 'pending',
        id: e.pointerId,
        target: t,
        interactive,
        onCard: t !== this.canvas,
        lx: p.x, ly: p.y,
        samples: [{ t: performance.now(), x: p.x, y: p.y }],
        threshold: e.pointerType === 'mouse' ? 4 : 9,
        flightWasActive: !!this._flight,
      };
      if (t === this.canvas) this._cancelFlight();
    } else if (this._pointers.size === 2) {
      this._cancelFlight();
      this._startPinch();
    }
  }

  _startPinch() {
    const [a, b] = [...this._pointers.values()];
    this._gesture = {
      ...(this._gesture || {}),
      mode: 'pinch',
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
    this._userMove();
    this._beginPanVisuals();
  }

  _beginPanVisuals() {
    document.documentElement.classList.add('plane-panning');
    try { window.getSelection()?.removeAllRanges(); } catch { /* ok */ }
  }

  _onPointerMove(e) {
    const p = this._local(e);
    const ptr = this._pointers.get(e.pointerId);
    if (!ptr) {
      // hover
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        const t = e.target instanceof Element ? e.target : null;
        const over = this._inWorld(t);
        this._hover.sx = p.x; this._hover.sy = p.y; this._hover.on = over;
        const pin = over && t === this.canvas ? this._pinAt(p.x, p.y) : null;
        if (pin !== this._hover.pin) {
          this._hover.pin = pin;
          document.documentElement.classList.toggle('plane-pin-hover', !!pin);
        }
        if (over) this._emitPointer(p);
      }
      return;
    }
    ptr.x = p.x; ptr.y = p.y;
    const g = this._gesture;
    if (!g) return;

    if (g.mode === 'pending' && e.pointerId === g.id) {
      if (Math.hypot(p.x - ptr.x0, p.y - ptr.y0) > g.threshold) {
        g.mode = 'pan';
        g.lx = p.x; g.ly = p.y;
        this._cancelFlight();
        this._userMove();
        this._beginPanVisuals();
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
      }
    }
    if (g.mode === 'pan' && e.pointerId === g.id) {
      const dx = p.x - g.lx, dy = p.y - g.ly;
      g.lx = p.x; g.ly = p.y;
      this.camera.x -= dx / this.camera.s;
      this.camera.y += dy / this.camera.s;
      this._clampCamera();
      const now = performance.now();
      g.samples.push({ t: now, x: p.x, y: p.y });
      while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();
      this._requestFrame();
    } else if (g.mode === 'pinch' && this._pointers.size >= 2) {
      const [a, b] = [...this._pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      this.camera.x -= (mid.x - g.mid.x) / this.camera.s;
      this.camera.y += (mid.y - g.mid.y) / this.camera.s;
      this._zoomAbout(mid.x, mid.y, this.camera.s * (dist / g.dist));
      g.mid = mid; g.dist = dist;
      this._requestFrame();
    }
    this._hover.sx = p.x; this._hover.sy = p.y;
    this._emitPointer(p);
  }

  _emitPointer(p) {
    const w = this.screenToWorld(p.x, p.y);
    this._pointerWorld = w;
    if (this._listeners.get('pointermove')?.size) this._emit('pointermove', { x: w.x, y: w.y, screenX: p.x, screenY: p.y });
  }

  _onPointerUp(e, cancelled) {
    const ptr = this._pointers.get(e.pointerId);
    if (!ptr) return;
    this._pointers.delete(e.pointerId);
    const g = this._gesture;
    if (!g) return;
    const p = this._local(e);

    if (g.mode === 'pinch') {
      if (this._pointers.size === 1) {
        // continue as a pan with the remaining finger, without a jump
        const [[id, rest]] = [...this._pointers.entries()];
        this._gesture = { ...g, mode: 'pan', id, lx: rest.x, ly: rest.y, samples: [{ t: performance.now(), x: rest.x, y: rest.y }] };
      } else if (this._pointers.size === 0) {
        this._endGesture(true);
      }
      return;
    }
    if (e.pointerId !== g.id) return;

    if (g.mode === 'pan') {
      if (!cancelled) this._flingFrom(g.samples, p);
      this._endGesture(true);
      return;
    }
    // pending → it was a tap
    this._endGesture(false);
    if (!cancelled) this._onTap(p, g, e);
  }

  _endGesture(wasDrag) {
    this._gesture = null;
    document.documentElement.classList.remove('plane-panning');
    if (wasDrag) {
      this._suppressClick = true;
      setTimeout(() => { this._suppressClick = false; }, 0);
    }
  }

  _flingFrom(samples, p) {
    if (this.reducedMotion) return;
    const now = performance.now();
    const recent = samples.filter((s) => now - s.t < 90);
    if (recent.length < 2) return;
    const a = recent[0], b = recent[recent.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.008 || now - b.t > 60) return;
    let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    const sp = Math.hypot(vx, vy);
    if (sp < 60) return;
    const max = 4200;
    if (sp > max) { vx *= max / sp; vy *= max / sp; }
    this._vel.x = vx; this._vel.y = vy;
    this._requestFrame();
  }

  _onTap(p, g, e) {
    const w = this.screenToWorld(p.x, p.y);
    const evt = { x: w.x, y: w.y, screenX: p.x, screenY: p.y, pointerType: e.pointerType, handled: false };
    this._emit('tap', evt);
    if (evt.handled || g.interactive) { this._lastTap = null; return; }
    if (g.target === this.canvas) {
      const pin = this._pinAt(p.x, p.y);
      if (pin) { this._lastTap = null; this.flyToPlace(pin); return; }
    }
    // double tap / double click → zoom in there
    const now = performance.now();
    const lt = this._lastTap;
    if (lt && now - lt.t < 320 && Math.hypot(p.x - lt.x, p.y - lt.y) < 30) {
      this._lastTap = null;
      this._zoomSmooth(2, p.x, p.y);
    } else {
      this._lastTap = { t: now, x: p.x, y: p.y };
    }
  }

  _onWheel(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!this._inWorld(t) || this._paused) return;
    e.preventDefault();
    this._cancelFlight();
    this._vel.x = this._vel.y = 0;
    this._glide = null;
    this._userMove();

    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 18; dy *= 18; } else if (e.deltaMode === 2) { dx *= this.H; dy *= this.H; }
    const now = performance.now();
    const fresh = now - this._wheel.last > 200;
    this._wheel.last = now;
    if (fresh) this._wheel.mode = e.ctrlKey ? 'zoom' : e.shiftKey || Math.abs(dx) > Math.abs(dy) * 1.2 ? 'pan' : 'zoom';
    if (e.ctrlKey) this._wheel.mode = 'zoom';

    const p = this._local(e);
    if (this._wheel.mode === 'pan') {
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      this._zoomAnim = null;
      this.panBy(dx, dy);
      return;
    }
    // zoom about the cursor. Notchy mouse wheels get smoothed; trackpads go direct.
    const k = e.ctrlKey ? 0.0105 : 0.0024;
    const factor = clamp(Math.exp(-dy * k), 0.5, 2);
    if (Math.abs(dy) >= 40 && !e.ctrlKey && !this.reducedMotion) {
      this._zoomSmooth(factor, p.x, p.y);
    } else {
      this._zoomAnim = null;
      this._zoomAbout(p.x, p.y, this.camera.s * factor);
      this._requestFrame();
    }
  }

  _onGesture(e, phase) {
    if (this._pointers.size) return; // touch pinch is handled by pointer events
    const t = e.target instanceof Element ? e.target : null;
    if (!this._inWorld(t)) return;
    e.preventDefault();
    if (phase === 'start') { this._gscale = 1; this._cancelFlight(); this._userMove(); return; }
    if (phase === 'change' && this._gscale) {
      const ratio = e.scale / this._gscale;
      this._gscale = e.scale;
      const p = this._local(e);
      this._zoomAbout(p.x, p.y, this.camera.s * ratio);
      this._requestFrame();
    }
    if (phase === 'end') this._gscale = 0;
  }

  _onKeyDown(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const ae = document.activeElement;
    if (isTextEntry(ae)) {
      if (e.key === 'Escape' && ae.id === 'input' && !document.body.classList.contains('is-vim')) ae.blur();
      return;
    }
    if (this._paused) return;
    const modal = document.getElementById('modal-3d');
    if (modal && !modal.hidden) return;

    const key = e.key;
    const calm = !ae || ae === document.body || ae === this.canvas || (ae.closest?.('.card') && !ae.closest(INTERACTIVE));
    if (key.startsWith('Arrow')) {
      if (ae?.closest?.('[role="listbox"], [role="menu"], [role="tablist"], [role="slider"]')) return;
      e.preventDefault();
      if (!this._keys.has(key)) {
        this._cancelFlight();
        this._zoomAnim = null;
        this._glide = null;
        this._userMove();
      }
      this._keys.add(key);
      this._requestFrame();
      return;
    }
    switch (key) {
      case '+': case '=':
        e.preventDefault(); this._zoomSmooth(1.4, this.W / 2, this.H / 2); return;
      case '-': case '_':
        e.preventDefault(); this._zoomSmooth(1 / 1.4, this.W / 2, this.H / 2); return;
      case '0':
        e.preventDefault(); this.home(); return;
      case '/': {
        const input = document.getElementById('input');
        if (input) { e.preventDefault(); input.focus({ preventScroll: true }); }
        return;
      }
      case 'Escape':
        if (ae && ae !== document.body) ae.blur?.();
        return;
      case 'n': case 'N': case 'p': case 'P':
        e.preventDefault(); this.next(key === 'p' || key === 'P' || e.shiftKey ? -1 : 1); return;
      case ' ':
        if (!calm) return;
        e.preventDefault(); this.next(e.shiftKey ? -1 : 1); return;
      default: {
        const place = this.places.find((p) => p.key === key);
        if (place) { e.preventDefault(); this.flyToPlace(place.id); }
      }
    }
  }

  _pinAt(sx, sy) {
    let best = null, bd = Infinity;
    for (const p of this.places) {
      const s = this.worldToScreen(p.x, p.y);
      const hx = s.x, hy = s.y - PIN_D * 0.75;
      const d = Math.hypot(sx - hx, (sy - hy) * 0.85);
      const onLabel = Math.abs(sx - s.x) < p.label.length * 4.2 + 8 && sy > s.y + 4 && sy < s.y + 24;
      if ((d < PIN_R + 12 || onLabel) && d < bd) { bd = d; best = p.id; }
    }
    return best;
  }

  _setPaused(paused, reason) {
    this._pauseReasons ||= new Set();
    if (paused) this._pauseReasons.add(reason);
    else this._pauseReasons.delete(reason);
    const now = this._pauseReasons.size > 0;
    if (now === this._paused) return;
    this._paused = now;
    if (now) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      this._keys.clear();
      this._pointers.clear();
      this._gesture = null;
      document.documentElement.classList.remove('plane-panning');
    } else {
      this._lastNow = 0;
      this.resize();
      this._requestFrame();
    }
  }

  _requestFrame() {
    if (this._paused || this._raf) return;
    this._raf = requestAnimationFrame(this._loop);
  }

  /* ---------------------------------------------------------------------- */
  /* the loop                                                                */
  /* ---------------------------------------------------------------------- */

  _loop = (now) => {
    this._raf = 0;
    if (this._paused) return;
    this._raf = requestAnimationFrame(this._loop); // always animating: t, pulses, route
    const raw = this._lastNow ? (now - this._lastNow) / 1000 : 1 / 60;
    const dt = clamp(raw, 0, 0.05); // physics step stays small…
    this._lastNow = now;
    this.clock += clamp(raw, 0, 0.25); // …but the intro/pulse clock keeps real time on slow devices
    if (!this.reducedMotion && !this.effects.frozen) this.time += dt * (Number.isFinite(this.effects.timeScale) ? this.effects.timeScale : 1);
    this._frame++;

    if (this._frame % 30 === 1) {
      this._measureHud();
      // belt and braces for the DPR watcher: some browsers move a window between screens without telling anyone
      if (Math.min(DPR_CAP, window.devicePixelRatio || 1) !== this.dpr) this.resize();
    }
    if (this._frame % 15 === 2) this._measureEdges();

    const s0 = this.camera.s;
    this._updateMotion(dt, now);
    if (this.camera.s !== s0) this._lastZoomAt = now;

    try {
      this._render(dt);
    } catch (err) {
      if (!this._renderErrorLogged) { console.error('[plane] render failed', err); this._renderErrorLogged = true; }
    }
  };

  _updateMotion(dt, now) {
    const c = this.camera;
    const f = this._flight;
    if (f) {
      const u = clamp((now - f.t0) / f.dur, 0, 1);
      if (u >= 1) {
        Object.assign(c, f.to);
        this._flight = null;
        f.resolve(true);
      } else {
        const [x, y, w] = f.fn(easeInOutCubic(u));
        c.x = x; c.y = y; c.s = clamp(f.view / w, S_MIN * 0.5, S_MAX);
      }
      return;
    }

    // keyboard pan: eased velocity, so it glides in and out
    const kx = (this._keys.has('ArrowRight') ? 1 : 0) - (this._keys.has('ArrowLeft') ? 1 : 0);
    const ky = (this._keys.has('ArrowDown') ? 1 : 0) - (this._keys.has('ArrowUp') ? 1 : 0);
    const kspeed = Math.min(this.W, this.H) * 1.1;
    const kd = this.reducedMotion ? 1 : damp(9, dt);
    this._keyVel.x = lerp(this._keyVel.x, kx * kspeed, kd);
    this._keyVel.y = lerp(this._keyVel.y, ky * kspeed, kd);
    if (Math.abs(this._keyVel.x) > 0.5 || Math.abs(this._keyVel.y) > 0.5) {
      c.x += (this._keyVel.x * dt) / c.s;
      c.y -= (this._keyVel.y * dt) / c.s;
    } else {
      this._keyVel.x = this._keyVel.y = 0;
    }

    // inertia
    const v = this._vel;
    if (v.x || v.y) {
      c.x -= (v.x * dt) / c.s;
      c.y += (v.y * dt) / c.s;
      const decay = Math.exp(-4.2 * dt);
      v.x *= decay; v.y *= decay;
      if (Math.hypot(v.x, v.y) < 6) v.x = v.y = 0;
    }

    // minimap glide
    if (this._glide) {
      const g = this._glide, d = damp(12, dt);
      c.x = lerp(c.x, g.x, d);
      c.y = lerp(c.y, g.y, d);
      if (Math.abs(c.x - g.x) * c.s < 0.3 && Math.abs(c.y - g.y) * c.s < 0.3) { c.x = g.x; c.y = g.y; this._glide = null; }
    }

    // smooth zoom (wheel notches, buttons, keys, double tap)
    const z = this._zoomAnim;
    if (z) {
      const cur = Math.log(c.s);
      let next = lerp(cur, z.logTarget, damp(15, dt));
      if (Math.abs(next - z.logTarget) < 0.0015) { next = z.logTarget; this._zoomAnim = null; }
      this._zoomAbout(z.ax, z.ay, Math.exp(next));
    }
    this._clampCamera();
  }

  /* ---------------------------------------------------------------------- */
  /* rendering                                                               */
  /* ---------------------------------------------------------------------- */

  _col(c) {
    const hue = this.effects.hue || 0;
    if (hue !== this._hueKey) { this._hueKey = hue; this._hueCache = new Map(); }
    const key = Array.isArray(c) ? c.join(',') : c;
    let out = this._hueCache.get(key);
    if (!out) { out = rotateHue(parseColor(c), hue); this._hueCache.set(key, out); }
    return out;
  }

  _render(dt) {
    const { ctx, W, H, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);

    // coffee jitter: shake the render offset (never under reduced motion)
    const j = this.reducedMotion ? 0 : clamp(+this.effects.jitter || 0, 0, 1);
    if (j > 0.001) {
      const amp = j * j * 7 + j * 1.5;
      this._ox = (Math.random() - 0.5) * 2 * amp;
      this._oy = (Math.random() - 0.5) * 2 * amp;
    } else {
      this._ox = this._oy = 0;
    }
    ctx.setTransform(dpr, 0, 0, dpr, this._ox * dpr, this._oy * dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this._drawGrid(ctx);
    this._drawAxes(ctx);
    if (this.routeVisible) this._drawRoute(ctx);
    this._drawCurves(ctx);
    this._drawPoints(ctx);
    this._drawPins(ctx, dt);

    for (const draw of this._overlays) {
      ctx.save();
      try { draw(ctx, this, dt, this.clock); } catch (err) {
        if (!draw.__planeLogged) { console.error('[plane] overlay failed', err); draw.__planeLogged = true; }
      }
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    if (this._listeners.get('frame')?.size) this._emit('frame', ctx, dt, this.clock);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    this._updateCards();
    this._updateEdges();
    this._drawMinimap();
    this._updateCoords();
  }

  _drawGrid(ctx) {
    const { W, H } = this;
    const { x: cx, y: cy, s } = this.camera;
    const x0 = cx - W / 2 / s, x1 = cx + W / 2 / s;
    const y0 = cy - H / 2 / s, y1 = cy + H / 2 / s;
    const MIN_PX = 9, FULL_PX = 130;
    const fine = ladderAtLeast(MIN_PX / s);
    const levels = [];
    for (let L = fine; levels.length < 9; L = ladderNext(L)) {
      levels.push(L);
      if (L * s >= FULL_PX) break;
    }
    // continuous intensity per level → no popping while zooming
    const alphaOf = levels.map((L) => 0.135 * Math.pow(clamp(Math.log((L * s) / 6) / Math.log(FULL_PX / 6), 0, 1), 1.6));
    const paths = levels.map(() => new Path2D());
    const spot = this._hover.glow > 0.01 ? new Path2D() : null;
    const levelOf = (i) => {
      for (let li = levels.length - 1; li > 0; li--) {
        const q = (i * fine) / levels[li];
        if (Math.abs(q - Math.round(q)) < 1e-6) return li;
      }
      return 0;
    };
    const dpr = this.dpr;
    const off = (dpr % 2) / 2;
    const snap = (v) => (Math.round(v * dpr - off) + off) / dpr;

    const iStart = Math.ceil(x0 / fine), iEnd = Math.floor(x1 / fine);
    for (let i = iStart; i <= iEnd; i++) {
      if (i === 0) continue;
      const li = levelOf(i);
      if (alphaOf[li] < 0.004) continue;
      const sx = snap(W / 2 + (i * fine - cx) * s);
      paths[li].moveTo(sx, 0); paths[li].lineTo(sx, H);
      if (spot) { spot.moveTo(sx, 0); spot.lineTo(sx, H); }
    }
    const jStart = Math.ceil(y0 / fine), jEnd = Math.floor(y1 / fine);
    for (let i = jStart; i <= jEnd; i++) {
      if (i === 0) continue;
      const li = levelOf(i);
      if (alphaOf[li] < 0.004) continue;
      const sy = snap(H / 2 - (i * fine - cy) * s);
      paths[li].moveTo(0, sy); paths[li].lineTo(W, sy);
      if (spot) { spot.moveTo(0, sy); spot.lineTo(W, sy); }
    }
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    for (let li = 0; li < levels.length; li++) {
      if (alphaOf[li] < 0.004) continue;
      ctx.strokeStyle = `rgba(120,150,255,${alphaOf[li].toFixed(4)})`;
      ctx.stroke(paths[li]);
    }
    // flashlight: the grid lights up a little around the cursor
    if (spot) {
      const h = this._hover;
      const g = ctx.createRadialGradient(h.sx, h.sy, 0, h.sx, h.sy, 230);
      g.addColorStop(0, `rgba(140,200,255,${(0.2 * h.glow).toFixed(3)})`);
      g.addColorStop(0.45, `rgba(140,170,255,${(0.07 * h.glow).toFixed(3)})`);
      g.addColorStop(1, 'rgba(140,170,255,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = g;
      ctx.stroke(spot);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.lineCap = 'round';
    this._labelStep = ladderAtLeast((W < 640 ? 58 : 74) / s);
  }

  _drawAxes(ctx) {
    const { W, H } = this;
    const { x: cx, y: cy, s } = this.camera;
    const ax = W / 2 - cx * s; // screen x of the y-axis
    const ay = H / 2 + cy * s; // screen y of the x-axis
    const topSafe = this._free.t;
    const glowAxis = new Path2D();
    const yAxisOn = ax > -10 && ax < W + 10;
    const xAxisOn = ay > -10 && ay < H + 10;
    if (xAxisOn) { glowAxis.moveTo(0, ay); glowAxis.lineTo(W - 4, ay); }
    if (yAxisOn) { glowAxis.moveTo(ax, H); glowAxis.lineTo(ax, topSafe + 4); }
    if (xAxisOn || yAxisOn) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(160,200,255,0.045)'; ctx.lineWidth = 9; ctx.stroke(glowAxis);
      ctx.strokeStyle = 'rgba(160,200,255,0.11)'; ctx.lineWidth = 3.4; ctx.stroke(glowAxis);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(160,200,255,0.55)'; ctx.lineWidth = 1.2; ctx.stroke(glowAxis);
      // arrow heads
      ctx.fillStyle = 'rgba(170,210,255,0.75)';
      if (xAxisOn) {
        ctx.beginPath(); ctx.moveTo(W - 3, ay); ctx.lineTo(W - 12, ay - 4.5); ctx.lineTo(W - 12, ay + 4.5); ctx.closePath(); ctx.fill();
      }
      if (yAxisOn) {
        const ty = topSafe + 3;
        ctx.beginPath(); ctx.moveTo(ax, ty); ctx.lineTo(ax - 4.5, ty + 9); ctx.lineTo(ax + 4.5, ty + 9); ctx.closePath(); ctx.fill();
      }
      ctx.font = 'italic 500 13px "Bricolage Grotesque", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(190,215,255,0.8)';
      if (xAxisOn) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('x', W - 8, ay - 7); }
      if (yAxisOn) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('y', ax + 9, topSafe + 4); }
    }

    // tick labels, GeoGebra style: stick to the axes, or to the screen edge if the axis wandered off
    const step = this._labelStep;
    ctx.font = '400 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(5,6,10,0.85)';
    ctx.fillStyle = '#5b6488';
    const ly = clamp(ay + 6, topSafe + 4, H - 17);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ticks = new Path2D();
    for (let i = Math.ceil((cx - W / 2 / s) / step), e = Math.floor((cx + W / 2 / s) / step); i <= e; i++) {
      if (i === 0) continue;
      const sx = W / 2 + (i * step - cx) * s;
      if (sx < 14 || sx > W - 22) continue;
      const txt = formatTick(i * step, step);
      ctx.strokeText(txt, sx, ly);
      ctx.fillText(txt, sx, ly);
      if (xAxisOn) { ticks.moveTo(sx, ay - 3); ticks.lineTo(sx, ay + 3); }
    }
    let lx, align;
    if (ax < 44) { lx = 6; align = 'left'; } else if (ax > W - 6) { lx = W - 6; align = 'right'; } else { lx = ax - 7; align = 'right'; }
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    for (let i = Math.ceil((cy - H / 2 / s) / step), e = Math.floor((cy + H / 2 / s) / step); i <= e; i++) {
      if (i === 0) continue;
      const sy = H / 2 - (i * step - cy) * s;
      if (sy < topSafe + 12 || sy > H - 10) continue;
      const txt = formatTick(i * step, step);
      ctx.strokeText(txt, lx, sy);
      ctx.fillText(txt, lx, sy);
      if (yAxisOn) { ticks.moveTo(ax - 3, sy); ticks.lineTo(ax + 3, sy); }
    }
    if (xAxisOn && yAxisOn) {
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.strokeText('0', ax - 6, ay + 5);
      ctx.fillText('0', ax - 6, ay + 5);
    }
    ctx.strokeStyle = 'rgba(160,200,255,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke(ticks);
  }

  _glowStroke(ctx, path, rgb, scale = 1, coreAlpha = 1) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 11 * scale; ctx.strokeStyle = rgba(rgb, 0.055 * coreAlpha); ctx.stroke(path);
    ctx.lineWidth = 4.6 * scale; ctx.strokeStyle = rgba(rgb, 0.17 * coreAlpha); ctx.stroke(path);
    ctx.lineWidth = 2 * scale; ctx.strokeStyle = rgba(rgb, 0.95 * coreAlpha); ctx.stroke(path);
    ctx.lineWidth = 0.8 * scale; ctx.strokeStyle = rgba(tint(rgb, 0.7), 0.55 * coreAlpha); ctx.stroke(path);
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawCurves(ctx) {
    const curves = [];
    for (const o of this.objects.values()) {
      if (o.kind === 'fn2d' && o.visible !== false && typeof o.f === 'function') curves.push(o);
    }
    // one evaluation budget per frame, shared by every curve: a pile of dense curves can't eat the frame
    const budget = Math.max(4000, Math.floor(CURVE_FRAME_BUDGET / Math.max(1, curves.length)));
    for (const o of curves) {
      const hit = this._curveCached(o, budget);
      if (!hit.path) continue;
      const rgb = this._col(o.color || '#3df5ff');
      if (hit.band) {
        ctx.fillStyle = rgba(rgb, 0.16 * (o.alpha ?? 1));
        ctx.fill(hit.band);
        this._glowStroke(ctx, hit.path, rgb, 0.6 * (o.width || 1), 0.7 * (o.alpha ?? 1));
      } else {
        this._glowStroke(ctx, hit.path, rgb, o.width || 1, o.alpha ?? 1);
      }
      const name = o.name ?? '';
      if (hit.labelAt && name) {
        const [lx, ly] = hit.labelAt;
        ctx.font = 'italic 600 13px "Bricolage Grotesque", system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(5,6,10,0.8)';
        ctx.strokeText(name, lx + 6, ly - 6);
        ctx.fillStyle = rgba(tint(rgb, 0.25), 0.9);
        ctx.fillText(name, lx + 6, ly - 6);
      }
    }
  }

  /** Does f(x, t) change with t? Probed once per function; anything weird counts as "yes" (redraw every frame). */
  _usesT(o) {
    if (o.__probedF === o.f) return o.__usesT;
    let uses = false;
    try {
      for (const x of [0.3, 1.7, -2.9, 4.1, -5.3, 7.7, 0, 11.3, -13.1]) {
        const a = o.f(x, 0.37), b = o.f(x, 1.91);
        if (typeof a !== 'number' || typeof b !== 'number') { uses = true; break; }
        if (Number.isFinite(a) !== Number.isFinite(b)) { uses = true; break; }
        if (Number.isFinite(a) && Math.abs(a - b) > 1e-9 * (1 + Math.abs(a))) { uses = true; break; }
      }
    } catch { uses = true; }
    o.__probedF = o.f;
    o.__usesT = uses;
    return uses;
  }

  /** The sampled path only changes when the camera, the viewport or (for t-curves) the time does. */
  _curveCached(o, budget) {
    const { x, y, s } = this.camera;
    let key = `${x},${y},${s},${this.W},${this.H},${this._free.t},${budget}`;
    if (this._usesT(o)) key += `,${this.time}`;
    const c = o.__curve;
    if (c && c.key === key && c.f === o.f) return c;
    const path = this._curvePath(o, budget);
    return (o.__curve = { key, f: o.f, path, band: this._curveBand, labelAt: this._curveLabelAt });
  }

  /** Adaptive sampling (~2 css px) with recursive refinement; breaks on NaN/∞/asymptotes.
   *  Curves that wiggle faster than the pixels can show are drawn as a per-column min/max band instead. */
  _curvePath(o, BUDGET = 60000) {
    const { W, H } = this;
    const { x: cx, y: cy, s } = this.camera;
    const t = this.time;
    const f = o.f;
    let evals = 0;
    const ev = (x) => {
      evals++;
      let y;
      try { y = f(x, t); } catch { y = NaN; }
      return typeof y === 'number' ? y : NaN;
    };
    const toSX = (x) => W / 2 + (x - cx) * s;
    const toSY = (y) => clamp(H / 2 - (y - cy) * s, -4 * H, 5 * H);
    const path = new Path2D();
    let pen = false;
    let any = false;
    const labelX = W - 64;
    this._curveLabelAt = null;
    let labelSet = false;

    const put = (x, y) => {
      const sx = toSX(x), sy = toSY(y);
      if (pen) path.lineTo(sx, sy);
      else { path.moveTo(sx, sy); pen = true; }
      any = true;
      if (!labelSet && sx >= labelX && sy > this._free.t + 20 && sy < H - 30) { this._curveLabelAt = [sx, sy]; labelSet = true; }
    };
    const seg = (xa, ya, xb, yb, depth) => {
      const fa = Number.isFinite(ya), fb = Number.isFinite(yb);
      if (!fa && !fb) { pen = false; return; }
      if (fa && fb) {
        const sya = H / 2 - (ya - cy) * s, syb = H / 2 - (yb - cy) * s;
        const jump = Math.abs(syb - sya);
        const bothOff = (sya < -H && syb < -H) || (sya > 2 * H && syb > 2 * H);
        if (jump < 18 || bothOff || depth >= 7 || evals > BUDGET) {
          if (jump > H * 0.75 && (depth >= 7 || evals > BUDGET)) { pen = false; put(xb, yb); return; }
          if (!pen) put(xa, ya);
          put(xb, yb);
          return;
        }
      } else if (depth >= 7 || evals > BUDGET) {
        if (fb) { pen = false; put(xb, yb); } else pen = false;
        return;
      }
      const xm = (xa + xb) / 2;
      const ym = ev(xm);
      seg(xa, ya, xm, ym, depth + 1);
      seg(xm, ym, xb, yb, depth + 1);
    };

    // base samples first: they tell us whether refining is even worth it
    const step = 2 / s;
    const xs = cx - W / 2 / s - step, xe = cx + W / 2 / s + step;
    const bx = [], by = [];
    for (let x = xs; x <= xe + 1e-9; x += step) { bx.push(x); by.push(ev(x)); }
    let jumpy = 0, finite = 0;
    for (let i = 1; i < by.length; i++) {
      if (!Number.isFinite(by[i]) || !Number.isFinite(by[i - 1])) continue;
      finite++;
      const d = Math.abs(by[i] - by[i - 1]) * s;
      if (d > 18) jumpy++; // a few huge jumps are asymptotes; most of them jumping means aliasing
    }

    this._curveBand = null;
    if (finite > 8 && jumpy > finite * 0.4) {
      // Oscillation finer than ~2px: per pixel column, the min/max of a few samples (what GeoGebra does).
      // Bounded cost, no seam. Drawn as a translucent band with a glowing outline, so it doesn't add up to white.
      const sub = 6;
      const x0 = cx - W / 2 / s;
      const band = new Path2D();
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          path.moveTo(run[0][0], run[0][1]);
          for (const [px, a] of run) path.lineTo(px, a);
          path.moveTo(run[0][0], run[0][2]);
          for (const [px, , b] of run) path.lineTo(px, b);
          band.moveTo(run[0][0], run[0][1]);
          for (const [px, a] of run) band.lineTo(px, a);
          for (let i = run.length - 1; i >= 0; i--) band.lineTo(run[i][0], run[i][2]);
          band.closePath();
          any = true;
        }
        run = [];
      };
      for (let px = 0; px <= W; px++) {
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < sub; k++) {
          // a golden-ratio offset per column breaks the moiré you get from evenly spaced samples
          const y = ev(x0 + (px + (k + ((px * 0.6180339887) % 1)) / sub) / s);
          if (Number.isFinite(y)) { if (y < lo) lo = y; if (y > hi) hi = y; }
        }
        if (lo === Infinity) { flush(); continue; }
        const a = toSY(hi), b = Math.max(toSY(lo), a + 0.5);
        run.push([px, a, b]);
        if (!labelSet && px >= labelX && a > this._free.t + 20 && a < H - 30) { this._curveLabelAt = [px, a]; labelSet = true; }
      }
      flush();
      this._curveBand = any ? band : null;
      return any ? path : null;
    }

    if (Number.isFinite(by[0])) put(bx[0], by[0]);
    for (let i = 1; i < bx.length; i++) seg(bx[i - 1], by[i - 1], bx[i], by[i], 0);
    return any ? path : null;
  }

  _drawPoints(ctx) {
    for (const o of this.objects.values()) {
      if (o.kind !== 'point' || o.visible === false || !Number.isFinite(o.x) || !Number.isFinite(o.y)) continue;
      const p = this.worldToScreen(o.x, o.y);
      if (p.x < -40 || p.x > this.W + 40 || p.y < -40 || p.y > this.H + 40) continue;
      const rgb = this._col(o.color || '#ff3df2');
      ctx.globalCompositeOperation = 'lighter';
      for (const [r, a] of [[15, 0.06], [9, 0.14], [5.5, 0.35]]) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fillStyle = rgba(rgb, a); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.6, 0, TAU); ctx.fillStyle = rgba(tint(rgb, 0.35), 1); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
      const label = o.name || o.label || '';
      if (label) {
        ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(5,6,10,0.8)';
        ctx.strokeText(label, p.x + 8, p.y - 6);
        ctx.fillStyle = rgba(tint(rgb, 0.3), 0.95);
        ctx.fillText(label, p.x + 8, p.y - 6);
      }
    }
  }

  /* ---------- route (Mapplic directions, minus the "recalculating") ---------- */

  _buildRoute() {
    const pts = this.tour.map((id) => this.placeById(id));
    const n = pts.length;
    this._route = [];
    if (n < 2) return;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const samples = catmullRomSegment(p0, p1, p2, p3, Math.max(12, Math.round(len * 1.4)));
      const cum = [0];
      for (let k = 1; k < samples.length; k++) cum.push(cum[k - 1] + Math.hypot(samples[k].x - samples[k - 1].x, samples[k].y - samples[k - 1].y));
      this._route.push({ pts: samples, cum, len: cum[cum.length - 1], from: p1, to: p2, start: total });
      total += cum[cum.length - 1];
    }
    this._routeLen = total;
  }

  _routePointAt(d) {
    d = ((d % this._routeLen) + this._routeLen) % this._routeLen;
    for (const seg of this._route) {
      if (d <= seg.start + seg.len) {
        const local = d - seg.start;
        const cum = seg.cum;
        let lo = 0, hi = cum.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < local) lo = m; else hi = m; }
        const u = (local - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
        const a = seg.pts[lo], b = seg.pts[hi];
        return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), seg, u: local / seg.len };
      }
    }
    const last = this._route[this._route.length - 1];
    return { ...last.pts[last.pts.length - 1], seg: last, u: 1 };
  }

  _drawRoute(ctx) {
    if (!this._route.length) return;
    const motion = !this.reducedMotion;
    const introT = this._intro.start >= 0 ? this.clock - this._intro.start : 99;
    const reveal = motion ? clamp((introT - 0.55) / 1.6, 0, 1) : 1;
    if (reveal <= 0) return;
    const revealLen = easeInOutCubic(reveal) * this._routeLen;
    const dashPhase = motion ? -this.clock * 26 : 0;
    let screenAcc = 0;
    ctx.setLineDash([]);
    for (const seg of this._route) {
      if (seg.start >= revealLen) break;
      const path = new Path2D();
      let prev = null, segScreen = 0;
      const limit = revealLen - seg.start;
      for (let k = 0; k < seg.pts.length; k++) {
        if (seg.cum[k] > limit) {
          // partial last point
          const a = seg.pts[k - 1], b = seg.pts[k];
          const u = (limit - seg.cum[k - 1]) / Math.max(1e-9, seg.cum[k] - seg.cum[k - 1]);
          const q = this.worldToScreen(lerp(a.x, b.x, u), lerp(a.y, b.y, u));
          path.lineTo(q.x, q.y);
          break;
        }
        const q = this.worldToScreen(seg.pts[k].x, seg.pts[k].y);
        if (prev) { path.lineTo(q.x, q.y); segScreen += Math.hypot(q.x - prev.x, q.y - prev.y); } else path.moveTo(q.x, q.y);
        prev = q;
      }
      const a = this.worldToScreen(seg.from.x, seg.from.y), b = this.worldToScreen(seg.to.x, seg.to.y);
      const ca = this._col(seg.from.color), cb = this._col(seg.to.color);
      const mk = (alpha) => {
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, rgba(ca, alpha));
        g.addColorStop(1, rgba(cb, alpha));
        return g;
      };
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 9; ctx.strokeStyle = mk(0.04); ctx.stroke(path);
      ctx.setLineDash([7, 11]);
      ctx.lineDashOffset = dashPhase + screenAcc;
      ctx.lineWidth = 3.6; ctx.strokeStyle = mk(0.16); ctx.stroke(path);
      ctx.lineWidth = 1.5; ctx.strokeStyle = mk(0.75); ctx.stroke(path);
      ctx.setLineDash([]);
      ctx.globalCompositeOperation = 'source-over';
      screenAcc += segScreen;
    }

    // the traveller: a little comet doing the tour forever
    if (motion && reveal >= 1) {
      const speed = 3.2; // units per second
      const head = this.clock * speed;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 14; i >= 0; i--) {
        const p = this._routePointAt(head - i * 0.22);
        const q = this.worldToScreen(p.x, p.y);
        const rgb = this._col(this._mixHex(p.seg.from.color, p.seg.to.color, p.u));
        const fade = 1 - i / 15;
        const r = i === 0 ? 3 : 2.4 * fade + 0.4;
        if (i === 0) {
          ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, TAU); ctx.fillStyle = rgba(rgb, 0.1); ctx.fill();
          ctx.beginPath(); ctx.arc(q.x, q.y, 5.5, 0, TAU); ctx.fillStyle = rgba(rgb, 0.3); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, TAU); ctx.fillStyle = rgba(i === 0 ? tint(rgb, 0.6) : rgb, 0.85 * fade); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  _mixHex(a, b, u) {
    const ca = parseColor(a), cb = parseColor(b);
    return [lerp(ca[0], cb[0], u), lerp(ca[1], cb[1], u), lerp(ca[2], cb[2], u)];
  }

  /* ---------- pins ---------- */

  _drawPins(ctx, dt) {
    const motion = !this.reducedMotion;
    const introT = this._intro.start >= 0 ? this.clock - this._intro.start : 99;
    const h = this._hover;
    h.glow = lerp(h.glow, h.on && !this._gesture && h.pin == null ? 1 : h.on ? 0.6 : 0, damp(6, dt));

    this.places.forEach((p, i) => {
      const st = this._pinState.get(p.id);
      st.hover = lerp(st.hover, this._hover.pin === p.id ? 1 : 0, motion ? damp(14, dt) : 1);
      const sp = this.worldToScreen(p.x, p.y);
      if (sp.x < -60 || sp.x > this.W + 60 || sp.y < -60 || sp.y > this.H + 80) return;
      const drop = motion ? clamp((introT - 0.15 - i * 0.11) / 0.75, 0, 1) : 1;
      if (drop <= 0) return;
      const e = easeOutBack(drop);
      const dy = (1 - e) * -70;
      const alpha = clamp(drop * 2.5, 0, 1);
      const rgb = this._col(p.color);
      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.globalAlpha = alpha;

      // pulsing ground rings
      ctx.globalCompositeOperation = 'lighter';
      if (motion) {
        for (let r = 0; r < 2; r++) {
          const ph = (this.clock * 0.45 + r * 0.5 + i * 0.137) % 1;
          const rad = 4 + ph * 26;
          ctx.beginPath();
          ctx.ellipse(0, 0, rad, rad * 0.42, 0, 0, TAU);
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = rgba(rgb, 0.6 * (1 - ph) * (1 - ph) * drop);
          ctx.stroke();
        }
      } else {
        ctx.beginPath(); ctx.ellipse(0, 0, 14, 6, 0, 0, TAU); ctx.lineWidth = 1.4; ctx.strokeStyle = rgba(rgb, 0.35); ctx.stroke();
      }
      ctx.beginPath(); ctx.ellipse(0, 0, 7, 2.8, 0, 0, TAU); ctx.fillStyle = rgba(rgb, 0.35); ctx.fill();

      // the pin itself
      const sc = 1 + 0.16 * st.hover;
      ctx.translate(0, dy);
      ctx.scale(sc, sc);
      const pin = this._pinPath;
      ctx.lineWidth = 9; ctx.strokeStyle = rgba(rgb, 0.07); ctx.stroke(pin);
      ctx.lineWidth = 4; ctx.strokeStyle = rgba(rgb, 0.2 + 0.15 * st.hover); ctx.stroke(pin);
      ctx.globalCompositeOperation = 'source-over';
      const grad = ctx.createLinearGradient(0, -PIN_D - PIN_R, 0, 0);
      grad.addColorStop(0, rgba(tint(rgb, 0.45), 1));
      grad.addColorStop(0.55, rgba(rgb, 1));
      grad.addColorStop(1, rgba(rgb.map((v) => v * 0.6), 1));
      ctx.fillStyle = grad;
      ctx.fill(pin);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(tint(rgb, 0.7), 0.7);
      ctx.stroke(pin);
      ctx.beginPath(); ctx.arc(0, -PIN_D, PIN_R * 0.42, 0, TAU); ctx.fillStyle = '#05060a'; ctx.fill();
      ctx.beginPath(); ctx.arc(0, -PIN_D, 1.7, 0, TAU); ctx.fillStyle = rgba(tint(rgb, 0.5), 1); ctx.fill();
      ctx.restore();

      // label under the tip
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const ly = sp.y + 8;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(5,6,10,0.75)';
      ctx.strokeText(p.label, sp.x, ly);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgba(rgb, 0.12 + 0.12 * st.hover);
      ctx.strokeText(p.label, sp.x, ly);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba(tint(rgb, 0.35 + 0.3 * st.hover), 0.95);
      ctx.fillText(p.label, sp.x, ly);
      ctx.restore();
    });
  }

  /* ---------- HTML cards ---------- */

  _updateCards() {
    if (!this._cards.size) return;
    const k = this.k;
    const dpr = this.dpr;
    const op = smoothstep(CARD_HIDE_K, CARD_FULL_K, k);
    const zooming = performance.now() - this._lastZoomAt < 200;
    const kk = Math.abs(k - 1) < 0.0015 ? 1 : k;
    const introT = this._intro.start >= 0 ? this.clock - this._intro.start : 99;
    let nearest = null, nd = Infinity;
    const rects = (this._cardRects = []);
    const cxs = this.W / 2, cys = (this._free.t + this._free.b) / 2;
    const parked = !this._flight && this._parkedAt && this._cards.has(this._parkedAt) ? this._parkedAt : null;
    for (const [id, c] of this._cards) {
      const p = this.placeById(id);
      const sp = this.worldToScreen(p.x, p.y + 1);
      const x = Math.round((sp.x + this._ox) * dpr) / dpr;
      const y = Math.round((sp.y + this._oy) * dpr) / dpr;
      const tf = `translate3d(${x}px,${y}px,0) translate(-50%,-100%) scale(${kk.toFixed(4)})`;
      if (tf !== c.tf) { c.el.style.transform = tf; c.tf = tf; }
      // cards arrive just after their pins drop in
      const reveal = this.reducedMotion ? 1 : smoothstep(0.5, 1.0, introT - this.places.indexOf(p) * 0.06);
      const o = Math.round((id === parked ? 1 : op) * reveal * 1000) / 1000;
      if (o !== c.op) { c.el.style.opacity = String(o); c.op = o; }
      const pe = o > 0.35 ? '' : 'none';
      if (pe !== c.pe) {
        c.el.style.pointerEvents = pe;
        c.el.classList.toggle('is-far', o < 0.01);
        c.pe = pe;
      }
      if (zooming !== c.wc) { c.el.style.willChange = zooming ? 'transform' : ''; c.wc = zooming; }
      if (o > 0.5 && c.w) {
        const l = sp.x - (c.w * k) / 2, t = sp.y - c.h * k;
        if (l < this.W && l + c.w * k > 0 && t < this.H && sp.y > 0) rects.push({ id: `card-${id}`, left: l, top: t, right: l + c.w * k, bottom: sp.y });
      }
      const cy = sp.y - (c.h * k) / 2;
      const d = Math.hypot(sp.x - cxs, cy - cys);
      if (d < nd) { nd = d; nearest = id; }
    }
    const activeId = parked || (op > 0.5 && nd < Math.min(this.W, this.H) * 0.33 ? nearest : null);
    for (const [id, c] of this._cards) {
      const a = id === activeId;
      if (a !== c.active) { c.el.classList.toggle('is-active', a); c.active = a; }
    }
  }

  /* ---------- edge arrows ---------- */

  _measureEdges() {
    for (const e of this._edges?.values() || []) {
      if (!e.shown) continue;
      const w = e.el.offsetWidth, h = e.el.offsetHeight;
      if (w && h) { e.w = w; e.h = h; e.measured = true; }
    }
  }

  _updateEdges() {
    if (!this._edges?.size) return;
    const { W, H } = this;
    const introT = this._intro.start >= 0 ? this.clock - this._intro.start : 99;
    const ready = this.reducedMotion || introT > 1.9;
    const M = 12;
    const sa = this._safe || { t: 0, r: 0, b: 0, l: 0 }; // notches, Dynamic Island, home indicator
    const ML = M + sa.l, MR = M + sa.r, MT = M + sa.t, MB = M + sa.b;
    const placed = [];
    const compact = W < 560;
    // chips dodge the HUD and any card that's on screen (on phones the card is most of the screen)
    const obstacles = this._hud.concat(this._cardRects || []);
    // …and the pins that are on screen (with their labels): a chip must never sit on the place it's next to
    for (const p of this.places) {
      const q = this.worldToScreen(p.x, p.y);
      if (q.x > -40 && q.x < W + 40 && q.y > -40 && q.y < H + 40) {
        const hw = p.label.length * 3.6 + 10;
        obstacles.push({ id: `pin-${p.id}`, left: q.x - hw, right: q.x + hw, top: q.y - PIN_D - PIN_R - 4, bottom: q.y + 22 });
      }
    }
    const dodge = (qx, qy, hw, hh, L, R, T, B) => {
      for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        for (const r of obstacles) {
          const l = r.left - hw - 8, rr = r.right + hw + 8, t = r.top - hh - 8, b = r.bottom + hh + 8;
          if (qx > l && qx < rr && qy > t && qy < b) {
            const cands = [[l, qy], [rr, qy], [qx, t], [qx, b]].filter(([x, y]) => x >= L - 0.5 && x <= R + 0.5 && y >= T - 0.5 && y <= B + 0.5);
            if (!cands.length) continue;
            cands.sort((u, v) => Math.hypot(u[0] - qx, u[1] - qy) - Math.hypot(v[0] - qx, v[1] - qy));
            [qx, qy] = cands[0];
            moved = true;
          }
        }
        if (!moved) break;
      }
      return [qx, qy];
    };
    for (const p of this.places) {
      const e = this._edges.get(p.id);
      const sp = this.worldToScreen(p.x, p.y);
      const tipY = sp.y - PIN_D * 0.6;
      // a pin hidden under a HUD panel counts as off-screen (hud-top is already covered by _free.t)
      const underHud = this._hud.some((r) => r.id !== 'hud-top' && sp.x > r.left && sp.x < r.right && tipY > r.top && tipY < r.bottom);
      const inside = !underHud && sp.x > 18 + sa.l && sp.x < W - 18 - sa.r && tipY > this._free.t + 8 && sp.y < H - 14 - sa.b;
      const show = ready && !inside;
      if (compact !== e.compact) {
        e.compact = compact;
        e.el.classList.toggle('is-compact', compact);
        e.measured = false;
      }
      if (show !== e.shown) {
        e.shown = show;
        if (show) { e.el.classList.remove('is-hidden'); e.vis = true; } // displayed now so it can be measured
      }
      if (show && !e.measured) {
        // measure once now that it's displayed (layout read, rare)
        const w = e.el.offsetWidth, h = e.el.offsetHeight;
        if (w && h) { e.w = w; e.h = h; e.measured = true; }
      }
      if (!show) continue;
      const hw = e.w / 2, hh = e.h / 2;
      const L = ML + hw, R = W - MR - hw, T = Math.max(MT, this._free.t + 6) + hh, B = H - MB - hh;
      const cx = W / 2, cy = (T + B) / 2;
      const dx = sp.x - cx, dy = tipY - cy;
      const tx = dx > 0 ? (R - cx) / dx : dx < 0 ? (L - cx) / dx : Infinity;
      const ty = dy > 0 ? (B - cy) / dy : dy < 0 ? (T - cy) / dy : Infinity;
      const tt = Math.min(tx, ty);
      let qx = clamp(cx + dx * tt, L, R), qy = clamp(cy + dy * tt, T, B);
      [qx, qy] = dodge(qx, qy, hw, hh, L, R, T, B);
      placed.push({ e, qx, qy, hw, hh, sp, tipY, p, L, R, T, B });
    }
    // keep chips from stacking on each other (and re-dodge after every nudge).
    // A chip pinned to a side edge can only slide along that edge, so separate along the free axis.
    const overlap = (a, b) => [a.hw + b.hw + 6 - Math.abs(a.qx - b.qx), a.hh + b.hh + 6 - Math.abs(a.qy - b.qy)];
    const onSide = (c) => Math.abs(c.qx - c.L) < 1 || Math.abs(c.qx - c.R) < 1;
    const onTopBottom = (c) => Math.abs(c.qy - c.T) < 1 || Math.abs(c.qy - c.B) < 1;
    for (let iter = 0; iter < 8; iter++) {
      let any = false;
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i], b = placed[j];
          const [ox, oy] = overlap(a, b);
          if (ox <= 0 || oy <= 0) continue;
          any = true;
          const alongY = onSide(a) || onSide(b) ? true : onTopBottom(a) || onTopBottom(b) ? false : oy < ox;
          if (alongY) {
            const s = a.qy < b.qy || (a.qy === b.qy && a.tipY < b.tipY) ? -1 : 1;
            a.qy += (s * oy) / 2; b.qy -= (s * oy) / 2;
          } else {
            const s = a.qx < b.qx || (a.qx === b.qx && a.sp.x < b.sp.x) ? -1 : 1;
            a.qx += (s * ox) / 2; b.qx -= (s * ox) / 2;
          }
        }
      }
      for (const c of placed) {
        c.qx = clamp(c.qx, c.L, c.R); c.qy = clamp(c.qy, c.T, c.B);
        [c.qx, c.qy] = dodge(c.qx, c.qy, c.hw, c.hh, c.L, c.R, c.T, c.B);
      }
      if (!any) break;
    }
    // still stacked (a corner with no room)? Hide the farther chip: the nav lists every place anyway
    placed.sort((u, v) => Math.hypot(u.p.x - this.camera.x, u.p.y - this.camera.y) - Math.hypot(v.p.x - this.camera.x, v.p.y - this.camera.y));
    const kept = [];
    const blocked = (c) => obstacles.some((r) => c.qx + c.hw > r.left + 2 && c.qx - c.hw < r.right - 2 && c.qy + c.hh > r.top + 2 && c.qy - c.hh < r.bottom - 2);
    for (const c of placed) {
      if (blocked(c)) continue; // no room left anywhere near its edge
      if (!kept.some((k) => { const [ox, oy] = overlap(c, k); return ox > 2 && oy > 2; })) kept.push(c);
    }
    for (const e of this._edges.values()) {
      const vis = e.shown && kept.some((c) => c.e === e);
      if (vis !== e.vis) { e.vis = vis; e.el.classList.toggle('is-hidden', !vis); }
    }
    for (const { e, qx, qy, hw, hh, sp, tipY, p } of kept) {
      const x = clamp(qx, ML + hw, W - MR - hw), y = clamp(qy, MT + hh, H - MB - hh);
      const tf = `translate3d(${(x - hw).toFixed(1)}px,${(y - hh).toFixed(1)}px,0)`;
      if (tf !== e.tf) { e.el.style.transform = tf; e.tf = tf; }
      const ang = Math.atan2(tipY - y, sp.x - x);
      const rot = `rotate(${ang.toFixed(3)}rad)`;
      if (rot !== e.rot) { e.icon.style.transform = rot; e.rot = rot; }
      const dist = Math.hypot(p.x - this.camera.x, p.y - this.camera.y);
      const d = `${dist < 10 ? dist.toFixed(1) : Math.round(dist)}u`;
      if (d !== e.d) { e.dist.textContent = d; e.d = d; }
    }
  }

  /* ---------- minimap ---------- */

  _minimapMap() {
    const w = this._mmW, h = this._mmH;
    if (!w || !h) return null;
    const b = this.bounds;
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    const pad = 6;
    const k = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    return { k, ox: (w - bw * k) / 2, oy: (h - bh * k) / 2, w, h };
  }

  _drawMinimap() {
    const ctx = this.mctx;
    if (!ctx) return;
    const m = this._minimapMap();
    if (!m) return;
    const dpr = this.dpr;
    const b = this.bounds;
    const X = (x) => m.ox + (x - b.minX) * m.k;
    const Y = (y) => m.oy + (b.maxY - y) * m.k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, m.w, m.h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // grid every 10 units, axes
    const grid = new Path2D();
    for (let x = Math.ceil(b.minX / 10) * 10; x <= b.maxX; x += 10) { if (x) { grid.moveTo(X(x), Y(b.maxY)); grid.lineTo(X(x), Y(b.minY)); } }
    for (let y = Math.ceil(b.minY / 10) * 10; y <= b.maxY; y += 10) { if (y) { grid.moveTo(X(b.minX), Y(y)); grid.lineTo(X(b.maxX), Y(y)); } }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,150,255,0.08)';
    ctx.stroke(grid);
    ctx.beginPath();
    ctx.moveTo(X(b.minX), Y(0)); ctx.lineTo(X(b.maxX), Y(0));
    ctx.moveTo(X(0), Y(b.minY)); ctx.lineTo(X(0), Y(b.maxY));
    ctx.strokeStyle = 'rgba(160,200,255,0.28)';
    ctx.stroke();

    // route
    if (this.routeVisible) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.setLineDash([2, 3]);
      ctx.lineDashOffset = this.reducedMotion ? 0 : -this.clock * 6;
      for (const seg of this._route) {
        ctx.beginPath();
        seg.pts.forEach((q, i) => (i ? ctx.lineTo(X(q.x), Y(q.y)) : ctx.moveTo(X(q.x), Y(q.y))));
        const g = ctx.createLinearGradient(X(seg.from.x), Y(seg.from.y), X(seg.to.x), Y(seg.to.y));
        g.addColorStop(0, rgba(this._col(seg.from.color), 0.55));
        g.addColorStop(1, rgba(this._col(seg.to.color), 0.55));
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalCompositeOperation = 'source-over';
    }

    // viewport
    const { W, H } = this;
    const { x: cx, y: cy, s } = this.camera;
    const vx0 = X(cx - W / 2 / s), vx1 = X(cx + W / 2 / s), vy0 = Y(cy + H / 2 / s), vy1 = Y(cy - H / 2 / s);
    ctx.save();
    ctx.beginPath(); ctx.rect(0.5, 0.5, m.w - 1, m.h - 1); ctx.clip();
    ctx.fillStyle = 'rgba(61,245,255,0.07)';
    ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(61,245,255,0.18)';
    ctx.lineWidth = 3;
    ctx.strokeRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(61,245,255,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(vx0) + 0.5, Math.round(vy0) + 0.5, Math.round(vx1 - vx0), Math.round(vy1 - vy0));
    ctx.restore();

    // pins
    for (const [i, p] of this.places.entries()) {
      const x = X(p.x), y = Y(p.y);
      const rgb = this._col(p.color);
      ctx.globalCompositeOperation = 'lighter';
      const pulse = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.clock * 2.4 + i);
      ctx.beginPath(); ctx.arc(x, y, 6 + pulse * 2, 0, TAU); ctx.fillStyle = rgba(rgb, 0.1); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3.6, 0, TAU); ctx.fillStyle = rgba(rgb, 0.3); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fillStyle = rgba(tint(rgb, 0.25), 1); ctx.fill();
    }

    // you are here (if the camera wandered off the map, an arrow at the border says so)
    const hx = X(cx), hy = Y(cy);
    if (hx < 0 || hx > m.w || hy < 0 || hy > m.h) {
      const ex = clamp(hx, 5, m.w - 5), ey = clamp(hy, 5, m.h - 5);
      const a = Math.atan2(hy - ey, hx - ex);
      ctx.save();
      ctx.translate(ex, ey); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-3, -3.5); ctx.lineTo(-3, 3.5); ctx.closePath();
      ctx.fillStyle = 'rgba(61,245,255,0.95)';
      ctx.fill();
      ctx.restore();
    }
  }

  _updateCoords() {
    const el = this.coordsEl;
    if (!el || this._frame % 3) return;
    const w = this._hover.on ? this.screenToWorld(this._hover.sx, this._hover.sy) : this.camera;
    const f = (v) => {
      const s = (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
      return s.replace('-', '−');
    };
    const txt = `(${f(w.x)}, ${f(w.y)})`;
    if (txt !== this._coordsText) { el.textContent = txt; this._coordsText = txt; }
  }
}

export default Plane;

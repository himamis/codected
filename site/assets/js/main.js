// main.js — wires the plane, the algebra panel, the input bar, and the nonsense.
//
// Core (plane + content + ui) is imported statically. Everything optional (math, commands, fx, 3D)
// is imported dynamically and guarded, so a broken joke can never take the grid down with it.

import { Plane } from './plane.js';
import { PLACES, TOUR } from './content.js';
import { toast, setAlgebraValue, renderObjText } from './ui.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const COLORS = {
  cyan: '#5ed6e0', violet: '#8f86e8', magenta: '#e06bd6', lime: '#a8d860', amber: '#f0b056', red: '#ee6a80',
  dim: '#9aa3c7',
};
// the colours the defaults already use (route magenta, g violet, f cyan) come last, so new curves stand out
const USER_PALETTE = [COLORS.lime, COLORS.amber, COLORS.red, COLORS.cyan, COLORS.magenta, COLORS.violet];
const MAIL = 'balazs@codected.com';

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => motionQuery.matches;
const mobileQuery = matchMedia('(max-width: 640px)');
const shortQuery = matchMedia('(max-height: 480px)'); // landscape phones: every pixel of height counts

const els = {
  canvas: $('#plane'),
  world: $('#world'),
  list: $('#algebra-list'),
  algebra: $('#algebra'),
  algebraToggle: $('#algebra-toggle'),
  algebraCount: $('.algebra-count'),
  form: $('#input-form'),
  input: $('#input'),
  boring: $('#boring'),
  boringToggle: $('#boring-toggle'),
  boringClose: $('#boring-close'),
  nav: $('#places'),
};

/* ------------------------------------------------------------------------------------------------ */
/* optional modules (lazy + guarded)                                                                */
/* ------------------------------------------------------------------------------------------------ */

// A failed load is not cached: the next call tries again (the wifi came back, the toast said "try again").
const retrySoft = (load, name) => {
  let p = null;
  return () => (p ||= load().catch((err) => {
    p = null;
    console.warn(`[codected] ${name} failed to load:`, err);
    return null;
  }));
};
let mathMod = null;
const getMath = retrySoft(() => import('./math.js').then((m) => (mathMod = m)), 'math.js');
const getFxMod = retrySoft(() => import('./fx.js'), 'fx.js');
const getCommandsMod = retrySoft(() => import('./commands.js'), 'commands.js');
const loadThree = retrySoft(() => import('./three-view.js'), 'three-view.js'); // fetched on first use only
getMath(); getFxMod(); getCommandsMod(); // warm-up

/* ------------------------------------------------------------------------------------------------ */
/* the plane                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

const plane = new Plane({
  canvas: els.canvas,
  worldEl: els.world,
  places: PLACES,
  reducedMotion: reducedMotion(),
});
// flipping the OS setting mid-visit takes effect right away
motionQuery.addEventListener?.('change', (e) => { plane.reducedMotion = e.matches; });

const flyToPlace = (id, opts) => plane.flyToPlace(id, opts);
const home = () => (typeof plane.home === 'function' ? plane.home() : flyToPlace('hello'));

/* ------------------------------------------------------------------------------------------------ */
/* algebra list                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/** id → { id, kind, src, label, color, builtin, li, obj } */
const entries = new Map();
let paletteIdx = 0;
const nextColor = () => USER_PALETTE[paletteIdx++ % USER_PALETTE.length];

function updateCount() {
  if (!els.algebraCount || !els.list) return;
  const n = els.list.children.length;
  els.algebraCount.textContent = `${n} object${n === 1 ? '' : 's'}`;
}
els.list?.addEventListener('algebra:change', updateCount);

/**
 * Create a list line.
 * opts: { id, kind: 'fn2d'|'point'|'fn3d'|'value'|'text'|'route', label, color, visible, deletable,
 *         title, onText, dim, badge, fresh }
 */
function makeLine(opts) {
  const { id, kind, label, color = COLORS.dim, visible = true, deletable = true, title, onText, dim, badge } = opts;
  const li = document.createElement('li');
  li.className = 'obj';
  li.dataset.id = id;
  li.dataset.kind = kind;
  li.style.setProperty('--c', color);
  const textOnly = kind === 'value' || kind === 'text';
  if (textOnly) li.classList.add('obj--text');
  if (dim) li.classList.add('obj--dim');
  if (!visible) li.classList.add('obj--hidden');

  let dot;
  if (textOnly) {
    dot = document.createElement('span');
    dot.className = 'obj-dot is-static';
    dot.setAttribute('aria-hidden', 'true');
  } else {
    dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'obj-dot';
    if (kind === 'fn3d') {
      dot.setAttribute('aria-label', `Open ${id} in 3D`);
    } else {
      dot.setAttribute('aria-pressed', String(visible));
      dot.setAttribute('aria-label', `Show ${id}`);
    }
  }

  const text = document.createElement('span');
  text.className = 'obj-text';
  renderObjText(text, label);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'obj-badge';
    b.textContent = badge;
    text.append(b);
  }
  if (title) text.title = title;
  if (onText && title === 'Edit') text.setAttribute('aria-label', `Edit ${label}`);
  if (onText) {
    text.classList.add('is-clickable');
    text.tabIndex = 0;
    text.setAttribute('role', 'button');
    text.addEventListener('click', onText);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onText(e); }
    });
  }

  let tail;
  if (deletable) {
    tail = document.createElement('button');
    tail.type = 'button';
    tail.className = 'obj-del';
    tail.setAttribute('aria-label', `Delete ${id}`);
    tail.textContent = '×';
  } else {
    tail = document.createElement('span');
    tail.setAttribute('aria-hidden', 'true');
  }

  li.append(dot, text, tail);
  if (opts.fresh) {
    li.classList.add('is-new');
    setTimeout(() => li.classList.remove('is-new'), 2600);
  }
  return li;
}

function addLine(entry, { before } = {}) {
  const li = makeLine(entry);
  entry.li = li;
  entries.set(entry.id, entry);
  if (before && before.parentNode === els.list) els.list.insertBefore(li, before);
  else {
    // user objects go above the built-in text lines (bugs/coffee/hire) so they stay at the bottom, GeoGebra-ish
    const firstText = els.list.querySelector('li[data-builtin-text]');
    if (!entry.builtin && firstText) els.list.insertBefore(li, firstText);
    else els.list.append(li);
  }
  if (entry.builtinText) li.dataset.builtinText = '';
  updateCount();
  if (!entry.builtin) li.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  return li;
}

function removeLine(id) {
  const e = entries.get(id);
  if (!e) return null;
  const next = e.li?.nextSibling || null;
  if (e.kind === 'fn2d' || e.kind === 'point') {
    try { plane.removeObject(id); } catch (err) { console.warn(err); }
  }
  e.li?.remove();
  entries.delete(id);
  try { mathMod?.releaseName?.(id); } catch { /* fine */ }
  updateCount();
  return next;
}

function setLineVisible(id, visible) {
  const e = entries.get(id);
  if (!e) return;
  e.visible = visible;
  e.li?.classList.toggle('obj--hidden', !visible);
  const dot = e.li?.querySelector('.obj-dot');
  dot?.setAttribute('aria-pressed', String(visible));
  if (e.kind === 'route') setRouteVisible(visible);
  else if (e.kind === 'fn2d' || e.kind === 'point') plane.setVisible(id, visible);
}

function setRouteVisible(v) {
  if (typeof plane.setRouteVisible === 'function') plane.setRouteVisible(v);
  else if ('showRoute' in plane) plane.showRoute = v;
  else if ('routeVisible' in plane) plane.routeVisible = v;
  else if (plane.objects?.has?.('route')) plane.setVisible('route', v);
  else plane.showRoute = v;
}

// one delegated handler for dots + delete buttons
els.list?.addEventListener('click', (e) => {
  const li = e.target.closest('li.obj');
  if (!li) return;
  const id = li.dataset.id;
  const entry = entries.get(id);
  if (e.target.closest('.obj-del')) {
    if (id === 'bugs') {
      toast('Bugs can’t be deleted. Only renamed to features.', { kind: 'joke' });
      return;
    }
    const next = removeLine(id);
    // keep keyboard focus somewhere sensible
    (next?.querySelector?.('button.obj-del, button.obj-dot') || els.input)?.focus({ preventScroll: true });
    return;
  }
  if (e.target.closest('button.obj-dot') && entry) {
    if (entry.kind === 'fn3d') return void open3D(entry.obj);
    setLineVisible(id, !(entry.visible ?? true));
  }
});

/** add a plane object + its line (replacing an existing one with the same id, in place) */
function addObject(obj, { src, fresh = true, deletable = true } = {}) {
  const id = String(obj.id ?? obj.name);
  let before = null;
  if (entries.has(id)) before = removeLine(id);
  else {
    try { if (plane.objects?.has?.(id)) plane.removeObject(id); } catch { /* fine */ }
  }
  const color = obj.color || nextColor();
  const visible = obj.visible ?? true;
  const kind = obj.kind;
  if (kind === 'fn2d' || kind === 'point') {
    plane.addObject({ ...obj, id, color, visible, label: obj.label, ...(kind === 'fn2d' ? { name: obj.name ?? id } : {}) });
  }
  const entry = {
    id, kind, src, label: obj.label ?? id, color, visible, obj: { ...obj, id, color },
    deletable, fresh, builtin: !!obj.builtin,
  };
  if (kind === 'fn3d') {
    entry.badge = '3D';
    entry.onText = () => open3D(entry.obj);
    entry.title = 'Open in 3D';
  } else if (src) {
    entry.onText = () => { els.input.value = src; els.input.focus(); els.input.select(); };
    entry.title = 'Edit';
  }
  addLine(entry, { before });
  return entry;
}

function clearUserObjects() {
  for (const [id, e] of [...entries]) if (!e.builtin) removeLine(id);
  paletteIdx = 0;
}

/** "Factory reset": everything a visitor typed or deleted goes back to how the page shipped. */
function restoreDefaults() {
  for (const id of [...entries.keys()]) removeLine(id);
  els.list?.replaceChildren(); // also lines other modules added (setAlgebraValue)
  paletteIdx = 0;
  seedDefaults();
  setRouteVisible(true);
}

/* ---- the default objects ---- */

function seedDefaults() {
  addObject({
    id: 'f', kind: 'fn2d', color: COLORS.cyan, builtin: true,
    label: 'f(x) = 1.2·sin(x + t)',
    f: (x, t) => 1.2 * Math.sin(x + t),
  }, { src: 'f(x) = 1.2 sin(x + t)', fresh: false });
  addObject({
    id: 'g', kind: 'fn2d', color: COLORS.violet, builtin: true,
    label: 'g(x) = 2·cos(x / 4) − 5',
    f: (x) => 2 * Math.cos(x / 4) - 5,
  }, { src: 'g(x) = 2cos(x/4) - 5', fresh: false });

  addLine({
    id: 'route', kind: 'route', builtin: true, color: COLORS.magenta, visible: true, deletable: false,
    label: 'route = Polyline(📍×5)', title: 'Next stop', fresh: false,
    onText: () => nextPlace(),
  });

  const textLine = (id, label, extra = {}) => addLine({
    id, kind: 'text', builtin: true, builtinText: true, deletable: false, label, fresh: false, ...extra,
  });
  textLine('bugs', 'bugs = 0', { dim: true, title: 'citation needed', deletable: true });
  textLine('coffee', 'coffee = 3', { color: COLORS.amber, title: 'type coffee' });
  textLine('hire', 'hire(me) = true', {
    color: COLORS.amber, title: 'run hire',
    onText: () => runText('hire'),
  });
  entries.get('hire')?.li?.classList.remove('obj--text'); // it's amber and proud
}

/* ------------------------------------------------------------------------------------------------ */
/* places: nav, next stop, arrive                                                                   */
/* ------------------------------------------------------------------------------------------------ */

let currentPlace = (location.hash || '').slice(1);
if (!PLACES.some((p) => p.id === currentPlace)) currentPlace = 'hello';

function markPlace(id) {
  if (!PLACES.some((p) => p.id === id)) return;
  currentPlace = id;
  for (const b of $$('.place-btn', els.nav)) {
    const on = b.dataset.place === id;
    if (on) b.setAttribute('aria-current', 'location'); else b.removeAttribute('aria-current');
    if (on && mobileQuery.matches) b.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  document.body.dataset.place = id;
}

function nextPlace() {
  const i = TOUR.indexOf(currentPlace);
  return flyToPlace(TOUR[(i + 1) % TOUR.length]);
}

// nav chips, [data-go] buttons, #brand and the zoom buttons are wired by plane.js itself.
els.world?.addEventListener('click', (e) => {
  const run = e.target.closest('[data-run]');
  if (run) typeAndRun(run.dataset.run);
});
// the help toast's commands are buttons too (typing on a phone keyboard is no fun)
document.getElementById('toasts')?.addEventListener('click', (e) => {
  const run = e.target.closest?.('[data-run]');
  if (run) typeAndRun(run.dataset.run);
});

/* ------------------------------------------------------------------------------------------------ */
/* input bar                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

const history = [];
let histIdx = -1;
let draft = '';
let commands = null;
let fx = null;

function inputFeedback(kind) {
  const f = els.form;
  if (!f) return;
  f.classList.remove('is-error', 'is-ok');
  void f.offsetWidth;
  f.classList.add(kind === 'error' ? 'is-error' : 'is-ok');
  clearTimeout(inputFeedback.t);
  inputFeedback.t = setTimeout(() => f.classList.remove('is-error', 'is-ok'), kind === 'error' ? 900 : 700);
}

async function open3D(obj) {
  const mod = await loadThree();
  if (!mod?.open3D) {
    toast('The third dimension is offline. Try again later.', { kind: 'error' });
    return;
  }
  try { await mod.open3D(obj); } catch (err) {
    console.warn('[codected] 3D failed:', err);
    toast('3D crashed. It happens to the best dimensions.', { kind: 'error' });
  }
}

/** run a line of input: commands first, then math */
async function runText(raw, { fromInput = false } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return false;

  // 1) commands
  try {
    if (!commands) await initFun();
    if (commands && (await commands.run(text))) {
      if (fromInput) els.input.value = '';
      return true;
    }
  } catch (err) {
    console.warn('[codected] command failed:', err);
  }

  // 2) math
  const math = await getMath();
  if (!math?.parseInput) {
    toast('The math engine is on a coffee break. Try again in a sec.', { kind: 'error' });
    inputFeedback('error');
    return false;
  }
  let obj;
  try {
    obj = math.parseInput(text, { taken: entries });
  } catch (err) {
    const msg = err?.name === 'MathError' || (math.MathError && err instanceof math.MathError)
      ? err.message
      : 'That didn’t parse. Try sin(x), (1, 2) or help.';
    if (!(err?.name === 'MathError' || (math.MathError && err instanceof math.MathError))) console.warn(err);
    toast(msg, { kind: 'error', ms: 4200 });
    inputFeedback('error');
    if (fromInput) els.input.select();
    return false;
  }

  const id = obj.name || `obj${entries.size}`;
  const prev = entries.get(id);
  if (prev && (prev.kind === 'route' || prev.builtinText)) {
    toast(`'${id}' is taken. By a ${id}.`, { kind: 'joke' });
    inputFeedback('error');
    if (fromInput) els.input.select();
    return false;
  }
  const color = entries.get(id)?.color && !entries.get(id)?.builtin ? entries.get(id).color : undefined;
  switch (obj.kind) {
    case 'fn2d':
      addObject({ id, kind: 'fn2d', f: obj.f, label: obj.label, color }, { src: text });
      break;
    case 'point': {
      addObject({ id, kind: 'point', x: obj.x, y: obj.y, label: obj.label, color }, { src: text });
      const p = plane.worldToScreen(obj.x, obj.y);
      const off = !Number.isFinite(p.x) || p.x < 40 || p.y < 40 || p.x > innerWidth - 40 || p.y > innerHeight - 40;
      if (off && Number.isFinite(obj.x) && Number.isFinite(obj.y)) {
        plane.flyTo({ x: obj.x, y: obj.y, s: plane.camera.s });
      }
      break;
    }
    case 'fn3d': {
      const entry = addObject({ id, kind: 'fn3d', f: obj.f, label: obj.label, color: color || nextColor() }, { src: text });
      open3D(entry.obj);
      break;
    }
    case 'value': {
      addObject({ id, kind: 'value', label: obj.label, value: obj.value, color: color || COLORS.dim }, { src: text });
      toast(obj.label, { kind: 'success' });
      break;
    }
    default:
      toast('Parsed it, but I have no idea what it is.', { kind: 'error' });
      inputFeedback('error');
      return false;
  }
  inputFeedback('ok');
  if (fromInput) els.input.value = '';
  return true;
}

els.form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  if (history[history.length - 1] !== text) history.push(text);
  if (history.length > 50) history.shift();
  histIdx = -1;
  draft = '';
  runText(text, { fromInput: true });
});

els.input?.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!history.length) return;
    e.preventDefault();
    if (histIdx === -1) { draft = els.input.value; }
    if (e.key === 'ArrowUp') histIdx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
    else histIdx = histIdx === -1 ? -1 : histIdx + 1;
    if (histIdx >= history.length) histIdx = -1;
    els.input.value = histIdx === -1 ? draft : history[histIdx];
    const n = els.input.value.length;
    requestAnimationFrame(() => els.input.setSelectionRange(n, n));
    e.stopPropagation();
  } else if (e.key === 'Escape') {
    if (!document.body.classList.contains('is-vim')) els.input.blur(); // in vim, Esc changes nothing. Accurate.
    e.stopPropagation();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && els.input.selectionStart === els.input.selectionEnd) {
    // nothing selected, so this is ^C, not copy
    toast(commands?.vim ? 'Type  :qa!  and press <Enter> to abandon all changes and exit Vim' : '^C — there is no exit. Only more grid.', { kind: 'joke' });
  }
});

/* "type" a snippet into the input, then run it (used by the little buttons on the cards) */
let typing = null;
async function typeAndRun(text) {
  if (typing) return;
  const input = els.input;
  if (mobileQuery.matches) setAlgebraOpen(true, { focus: false });
  if (reducedMotion()) {
    input.value = text;
  } else {
    typing = true;
    input.value = '';
    for (const ch of text) {
      input.value += ch;
      await new Promise((r) => setTimeout(r, 22 + Math.random() * 26));
    }
    await new Promise((r) => setTimeout(r, 140));
    typing = null;
  }
  if (history[history.length - 1] !== text) history.push(text);
  await runText(text, { fromInput: true });
}

/* rotating placeholder, GeoGebra-style hints */
const HINTS = ['Input…', 'try help', 'try sin(x)', 'try (2, 3)', 'try x^2/4 − 3', 'try z = xy', 'try coffee'];
let hintIdx = 0;
if (!reducedMotion()) {
  setInterval(() => {
    const input = els.input;
    if (!input || document.hidden || document.activeElement === input || input.value) return;
    if (document.body.classList.contains('is-vim')) return;
    hintIdx = (hintIdx + 1) % HINTS.length;
    input.placeholder = HINTS[hintIdx];
  }, 3600);
}

/* ------------------------------------------------------------------------------------------------ */
/* algebra panel: collapse + mobile bottom sheet                                                    */
/* ------------------------------------------------------------------------------------------------ */

function setAlgebraOpen(open, { focus = false } = {}) {
  els.algebra?.classList.toggle('is-collapsed', !open);
  els.algebraToggle?.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('is-sheet-open', open); // phones hide the floating home button under it
  if (focus && open) els.input?.focus();
}
els.algebraToggle?.addEventListener('click', () => {
  setAlgebraOpen(els.algebraToggle.getAttribute('aria-expanded') !== 'true');
});
const algebraStartsOpen = () => !mobileQuery.matches && !shortQuery.matches;
setAlgebraOpen(algebraStartsOpen());
mobileQuery.addEventListener?.('change', () => setAlgebraOpen(algebraStartsOpen()));
shortQuery.addEventListener?.('change', () => setAlgebraOpen(algebraStartsOpen()));

// let the bottom-right HUD sit above the bottom sheet on phones
if ('ResizeObserver' in window && els.algebra) {
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--sheet-h', `${Math.round(els.algebra.getBoundingClientRect().height)}px`);
  }).observe(els.algebra);
}

/* ------------------------------------------------------------------------------------------------ */
/* boring mode                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

let boring = false;
function setBoring(on) {
  if (on === boring) return;
  boring = on;
  els.boring.hidden = !on;
  if (els.world) els.world.hidden = on; // one visible <main> at a time
  document.body.classList.toggle('is-boring', on);
  els.boringToggle?.setAttribute('aria-pressed', String(on));
  // plane.js pauses itself while body.is-boring is set
  if (on) {
    els.boring.scrollTop = 0;
    els.boring.focus({ preventScroll: true });
  } else {
    els.boringToggle?.focus({ preventScroll: true });
    // drop '#boring' so a reload doesn't reopen it
    if (location.hash === '#boring') {
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* fine */ }
    }
  }
}
els.boringToggle?.addEventListener('click', () => setBoring(!boring));
els.boringClose?.addEventListener('click', () => setBoring(false));
$('.skip-link')?.addEventListener('click', (e) => { e.preventDefault(); setBoring(true); });
els.boring?.addEventListener('keydown', (e) => { if (e.key === 'Escape') setBoring(false); });
if (/^#boring$/.test(location.hash) || new URLSearchParams(location.search).has('boring')) setBoring(true);

/* ------------------------------------------------------------------------------------------------ */
/* fun: fx + commands                                                                               */
/* ------------------------------------------------------------------------------------------------ */

let funReady = null;
function initFun() {
  return (funReady ||= (async () => {
    const [fxMod, cmdMod] = await Promise.all([getFxMod(), getCommandsMod()]);
    if (!cmdMod) funReady = null; // try again on the next command
    try {
      if (!fx && fxMod?.createFx) fx = fxMod.createFx(plane, { reducedMotion });
    } catch (err) { console.warn('[codected] fx init failed:', err); fx = null; }
    try {
      if (cmdMod?.createCommands) {
        commands = cmdMod.createCommands({
          plane,
          toast,
          places: PLACES,
          flyToPlace,
          addObject: (obj) => addObject(obj),
          clearUserObjects,
          restoreDefaults,
          setBoring,
          isBoring: () => boring,
          home,
          setAlgebraValue,
          fx,
          reducedMotion,
          openMail: () => { location.href = `mailto:${MAIL}`; },
        });
      }
    } catch (err) { console.warn('[codected] commands init failed:', err); commands = null; }
  })());
}

/* Konami → party */
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konami = 0;
window.addEventListener('keydown', (e) => {
  if (e.target === els.input || boring || !document.getElementById('modal-3d')?.hidden || e.target.closest?.('input, textarea, [contenteditable]')) {
    konami = 0;
    return;
  }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  konami = k === KONAMI[konami] ? konami + 1 : (k === KONAMI[0] ? 1 : 0);
  if (konami === KONAMI.length) {
    konami = 0;
    toast('↑↑↓↓←→←→BA — cheat code accepted.', { kind: 'success' });
    runText('party');
  }
});

/* ------------------------------------------------------------------------------------------------ */
/* boot                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

seedDefaults();
markPlace(currentPlace);

plane.on('arrive', (id) => markPlace(id));
addEventListener('hashchange', () => {
  if (location.hash === '#boring') setBoring(true);
  else if (boring) setBoring(false); // Back out of #boring
});

// the 3D view covers the plane: stop drawing what nobody can see
document.addEventListener('three:open', () => { plane.pause('3d'); document.documentElement.classList.add('is-3d'); });
document.addEventListener('three:close', () => { plane.resume('3d'); document.documentElement.classList.remove('is-3d'); });

initFun();

/* ------------------------------------------------------------------------------------------------ */
/* console easter egg                                                                               */
/* ------------------------------------------------------------------------------------------------ */

window.codected = Object.freeze({
  plot: (src) => runText(src),
  run: (cmd) => runText(cmd),
  fly: (id) => flyToPlace(id),
  places: PLACES.map((p) => ({ ...p })),
  help() {
    console.log('codected.plot("sin(x)") · codected.run("coffee") · codected.fly("mapplic") · codected.places');
    return 'Also try: codected.run("sudo make me a sandwich")';
  },
});

try {
  console.log(
    '%ccodected%c\n%cYou opened the console. Of course you did.\n' +
      'Try: codected.help() · codected.plot("sin(x + t)") · codected.run("party") · codected.fly("mapplic")\n' +
      `Hiring? ${MAIL}`,
    'font: 800 42px/1.1 "Bricolage Grotesque", system-ui, sans-serif; color: #5ed6e0; text-shadow: 0 0 8px #5ed6e0, 0 0 22px #8f86e8; letter-spacing: -2px;',
    '',
    'font: 12px/1.6 "JetBrains Mono", ui-monospace, monospace; color: #9aa3c7;',
  );
} catch { /* consoles without CSS: their loss */ }

// tell the inline watchdog in index.html that we made it
document.documentElement.dataset.booted = '1';
document.documentElement.classList.remove('no-boot');

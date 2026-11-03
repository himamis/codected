// ui.js — tiny shared UI helpers (no imports, so anyone can import it without cycles).

const TAGS = { info: 'info', error: 'err', success: 'ok', joke: 'lol' };
const MAX_TOASTS = 4;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Show a toast.
 * @param {string} message  text (or HTML when html: true)
 * @param {{kind?: 'info'|'error'|'success'|'joke', ms?: number, html?: boolean}} opts
 * @returns {{el: HTMLElement|null, update(msg: string, html?: boolean): void, close(): void}}
 */
export function toast(message, { kind = 'info', ms = 3200, html = false } = {}) {
  const host = document.getElementById('toasts');
  const noop = { el: null, update() {}, close() {} };
  if (!host) return noop;
  if (!TAGS[kind]) kind = 'info';

  // keep the stack short: drop the oldest
  const live = [...host.querySelectorAll('.toast:not(.is-leaving)')];
  for (let i = 0; i <= live.length - MAX_TOASTS; i++) dismiss(live[i]);

  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  const tag = document.createElement('span');
  tag.className = 'toast-tag';
  tag.setAttribute('aria-hidden', 'true');
  tag.textContent = TAGS[kind];
  const body = document.createElement('div');
  body.className = 'toast-body';
  setBody(body, message, html);
  el.append(tag, body);
  host.append(el);

  let timer = 0;
  let remaining = Math.max(800, ms);
  let started = performance.now();
  const arm = () => {
    clearTimeout(timer);
    started = performance.now();
    if (Number.isFinite(remaining)) timer = setTimeout(() => dismiss(el), remaining);
  };
  el.addEventListener('pointerenter', () => {
    clearTimeout(timer);
    remaining = Math.max(900, remaining - (performance.now() - started));
  });
  el.addEventListener('pointerleave', arm);
  el.addEventListener('click', () => dismiss(el));
  arm();

  return {
    el,
    update(msg, asHtml = html) {
      setBody(body, msg, asHtml);
      remaining = Math.max(800, ms);
      arm();
    },
    close() { dismiss(el); },
  };
}

function setBody(body, message, html) {
  if (html) body.innerHTML = String(message);
  else body.textContent = String(message);
}

function dismiss(el) {
  if (!el || !el.isConnected || el.classList.contains('is-leaving')) return;
  el.classList.add('is-leaving');
  const done = () => el.remove();
  el.addEventListener('animationend', (e) => { if (e.animationName === 'toast-out') done(); });
  setTimeout(done, 400); // reduced-motion / no-animation safety net
}

/**
 * Format "name = value" GeoGebra style into an .obj-text element.
 * Exported for main.js; the name part gets a colour, the value stays plain.
 */
export function renderObjText(el, text) {
  const s = String(text);
  const i = s.indexOf(' = ');
  el.textContent = '';
  if (i > 0) {
    const name = document.createElement('span');
    name.className = 'obj-name';
    name.textContent = s.slice(0, i);
    const eq = document.createElement('span');
    eq.className = 'obj-eq';
    eq.textContent = ' = ';
    el.append(name, eq, document.createTextNode(s.slice(i + 3)));
  } else {
    el.textContent = s;
  }
}

/**
 * Update (or create) a text-only line in the algebra list, e.g. setAlgebraValue('coffee', 4).
 * `text` may be just the value ("4") or the whole line ("coffee = 4").
 */
export function setAlgebraValue(name, text) {
  const list = document.getElementById('algebra-list');
  if (!list) return;
  const value = String(text);
  const line = value.includes(' = ') ? value : `${name} = ${value}`;

  let li = [...list.children].find((n) => n.dataset.id === String(name));
  if (!li) {
    li = document.createElement('li');
    li.className = 'obj obj--text';
    li.dataset.id = String(name);
    li.style.setProperty('--c', '#9aa3c7');
    const dot = document.createElement('span');
    dot.className = 'obj-dot is-static';
    dot.setAttribute('aria-hidden', 'true');
    const span = document.createElement('span');
    span.className = 'obj-text';
    const pad = document.createElement('span');
    pad.setAttribute('aria-hidden', 'true');
    li.append(dot, span, pad);
    list.append(li);
    list.dispatchEvent(new CustomEvent('algebra:change', { bubbles: true }));
  }
  const span = li.querySelector('.obj-text');
  if (!span) return;
  const before = span.textContent;
  renderObjText(span, line);
  if (before !== span.textContent) {
    li.classList.remove('is-bumped');
    void li.offsetWidth; // restart the animation
    li.classList.add('is-bumped');
  }
}

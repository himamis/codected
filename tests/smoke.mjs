// Smoke test: boots the real site in Chromium and pokes it with a stick.
//   npm install && npx playwright install chromium   (once)
//   npm run smoke                                     (or: node tests/smoke.mjs)
// Not a *.test.mjs file on purpose, so `node --test tests/*.test.mjs` (CI) never picks it up.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('smoke: playwright is not installed. Run `npm install && npx playwright install chromium` first.');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.argv.includes('--headed');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(port) {
  const child = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errOut = '';
  child.stderr.on('data', (d) => { errOut += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${errOut}`);
    try { const r = await fetch(base + '/'); if (r.ok) return { child, base }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('server did not start within 5s');
}

const results = [];
let failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed++;
    results.push(`  FAIL ${name}\n       ${String(err?.message || err).split('\n')[0]}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const port = await freePort();
const { child: server, base } = await startServer(port);
const browser = await chromium.launch({ headless: !HEADED });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function suite(label, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GPU stall|ReadPixels/i.test(t)) return; // headless GPU noise, not ours
    problems.push(t);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const run = async (text) => {
    await page.fill('#input', text);
    await page.press('#input', 'Enter');
  };
  const lastToast = () => page.$$eval('#toasts .toast .toast-body', (els) => els.at(-1)?.textContent || '');

  await check(`${label}: page loads, the plane renders`, async () => {
    const res = await page.goto(base + '/', { waitUntil: 'load' });
    assert(res.ok(), `GET / → ${res.status()}`);
    await page.waitForFunction(() => window.codected && document.querySelectorAll('#algebra-list li').length >= 6, null, { timeout: 8000 });
    await page.waitForFunction(() => +getComputedStyle(document.querySelector('#card-hello')).opacity > 0.9, null, { timeout: 8000 });
    // slow CI runners can need a few frames before the plane is drawn, so poll instead of sampling once
    const painted = await page.waitForFunction(() => {
      const c = document.querySelector('#plane');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) lit++;
      return lit > 50 && lit;
    }, null, { timeout: 8000, polling: 250 }).then((h) => h.jsonValue(), () => 0);
    assert(painted > 50, 'the canvas looks empty');
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert(sw <= iw, `horizontal scroll: ${sw} > ${iw}`);
  });

  await check(`${label}: plots sin(x)`, async () => {
    const before = await page.$$eval('#algebra-list li', (l) => l.length);
    await run('sin(x)');
    await page.waitForFunction((n) => document.querySelectorAll('#algebra-list li').length === n + 1, before, { timeout: 4000 });
    const text = await page.$$eval('#algebra-list li .obj-text', (els) => els.map((e) => e.textContent).join('\n'));
    assert(/sin\(x\)/.test(text), 'no sin(x) line in the algebra list');
    assert(await page.inputValue('#input') === '', 'input was not cleared');
  });

  await check(`${label}: nonsense gives a friendly error`, async () => {
    await run('asdfgh');
    await page.waitForSelector('#toasts .toast--error', { timeout: 3000 });
  });

  await check(`${label}: commands (help, vim → :q → :q!)`, async () => {
    await run('help');
    await page.waitForFunction(() => /Commands:/.test([...document.querySelectorAll('#toasts .toast-body')].map((e) => e.textContent).join(' ')), null, { timeout: 3000 });
    await run('vim');
    await page.waitForFunction(() => document.body.classList.contains('is-vim'), null, { timeout: 3000 });
    await run(':q'); // the classic: the first :q doesn't work
    await page.waitForFunction(() => /E37/.test([...document.querySelectorAll('#toasts .toast-body')].map((e) => e.textContent).join(' ')), null, { timeout: 3000 });
    assert(await page.evaluate(() => document.body.classList.contains('is-vim')), 'the first :q should not exit vim');
    await run(':q!');
    await page.waitForFunction(() => !document.body.classList.contains('is-vim'), null, { timeout: 3000 });
    assert(/Freedom/.test(await lastToast()), 'vim exit did not say "Freedom."');
  });

  await check(`${label}: a malformed hash doesn't take the page down`, async () => {
    await page.evaluate(() => { location.hash = '#%zz'; });
    await sleep(100);
    await page.evaluate(() => { history.replaceState(null, '', location.pathname); });
  });

  await check(`${label}: nav flies to a place and sets the hash`, async () => {
    const btn = page.locator('.place-btn[data-place="mapplic"]');
    if (contextOpts.hasTouch) await btn.tap(); else await btn.click();
    await page.waitForFunction(() => location.hash === '#mapplic', null, { timeout: 5000 });
  });

  await check(`${label}: boring mode opens and closes`, async () => {
    const toggle = page.locator('#boring-toggle');
    if (contextOpts.hasTouch) await toggle.tap(); else await toggle.click();
    await page.waitForFunction(() => !document.querySelector('#boring').hidden && document.body.classList.contains('is-boring'), null, { timeout: 3000 });
    const words = await page.$eval('#boring', (b) => b.innerText);
    assert(/GeoGebra/.test(words) && /Mapplic/.test(words) && /balazs@codected\.com/.test(words), 'boring version is missing content');
    const close = page.locator('#boring-close');
    if (contextOpts.hasTouch) await close.tap(); else await close.click();
    await page.waitForFunction(() => document.querySelector('#boring').hidden && !document.body.classList.contains('is-boring'), null, { timeout: 3000 });
  });

  await check(`${label}: deep link /#contact`, async () => {
    await page.goto('about:blank'); // a real fresh load, not a same-document hash change
    await page.goto(base + '/#contact', { waitUntil: 'load' });
    // settled = fully visible and horizontally centred (the intro flight lands there)
    await page.waitForFunction(() => {
      const c = document.querySelector('#card-contact');
      const r = c.getBoundingClientRect();
      return +getComputedStyle(c).opacity > 0.9 && Math.abs(r.left + r.width / 2 - innerWidth / 2) < innerWidth * 0.1;
    }, null, { timeout: 8000 });
  });

  await sleep(300); // let late errors surface
  await check(`${label}: no console errors`, async () => {
    assert(!problems.length, problems.join(' | '));
  });
  await context.close();
}

try {
  await suite('desktop', { viewport: { width: 1440, height: 900 } });
  await suite('mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await check('404 page is served for unknown paths', async () => {
    const r = await fetch(base + '/definitely-not-here');
    assert(r.status === 404, `status ${r.status}`);
    assert(/removable discontinuity|404/i.test(await r.text()), '404 body looks wrong');
  });
} finally {
  await browser.close().catch(() => {});
  server.kill();
}

console.log(`smoke (${base})\n${results.join('\n')}`);
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll green. Ship it.');
process.exit(failed ? 1 : 0);

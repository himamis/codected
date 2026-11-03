// commands.js — the input bar's dark side.
// createCommands(ctx).run(text) → true if the text was a command (handled), false to let math have it.
// Rule #1: never swallow math. "e", "pi", "x^2", "exp(x)" etc. must fall through.

const HAS_DOM = typeof document !== 'undefined';
const $ = (sel) => (HAS_DOM ? document.querySelector(sel) : null);
const bodyClass = (name, on) => { if (HAS_DOM && document.body) document.body.classList.toggle(name, on); };

const PLACE_FILES = { hello: 'hello.md', geogebra: 'geogebra/', mapplic: 'mapplic/', stack: 'stack.txt', contact: 'contact.sh' };
const COLORS = { hello: '#3df5ff', geogebra: '#8a7dff', mapplic: '#ff3df2', stack: '#b6ff3d', contact: '#ffb23d' };
const VIM_EXITS = new Set([':q', ':q!', ':wq', ':wq!', ':x', ':x!', 'zz', ':qa', ':qa!', ':wqa']);

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const code = (s) => `<code>${s}</code>`;
// a command you can click (the toast host delegates [data-run]); label is display HTML, cmd is what runs
const btn = (cmd, label = esc(cmd)) => `<button class="try" type="button" data-run="${esc(cmd)}">${label}</button>`;
// each item carries its trailing dot in a no-wrap box, so a line never starts with "·"
const dotted = (items) => items.map((x, i) => (i < items.length - 1 ? `<span class="nw">${x}&nbsp;·</span>` : x)).join(' ');


export function createCommands(ctx) {
  const toast = (msg, opts = {}) => ctx.toast?.(msg, { kind: 'joke', ...opts });
  const reduced = () => (typeof ctx.reducedMotion === 'function' ? !!ctx.reducedMotion() : !!ctx.reducedMotion);
  const effects = () => ctx.plane?.effects || {};
  const places = ctx.places || [];
  const fly = (id) => (ctx.flyToPlace ? ctx.flyToPlace(id) : ctx.plane?.flyToPlace?.(id));
  const home = () => (ctx.home ? ctx.home() : fly('hello'));

  const state = {
    vim: false,
    savedPlaceholder: null,
    coffee: 3,
    party: false,
    partyBurstAt: 0,
    matrixUntil: 0,
    collapsing: false,
    shakeUntil: 0,
    shakeLevel: 0,
  };

  // ---- shared per-frame driver (party hue, matrix tint, short shakes) -------
  let frameHooked = false;
  function hookFrame() {
    if (frameHooked || !ctx.plane?.on) return;
    frameHooked = true;
    ctx.plane.on('frame', () => {
      const fx = effects();
      const now = performance.now();
      if (state.party && !reduced()) {
        fx.hue = ((now / 1000) * 80) % 360;
        if (now - state.partyBurstAt > 3200) { state.partyBurstAt = now; ctx.fx?.confetti?.(46); }
      } else if (now < state.matrixUntil) {
        fx.hue = 292; // cyan → matrix green
      } else if (fx.hue && !state.party) {
        fx.hue = 0;
      }
      fx.jitter = now < state.shakeUntil && !reduced() ? state.shakeLevel : coffeeJitter();
    });
  }
  const coffeeJitter = () => (reduced() ? 0 : Math.max(0, Math.min(1, (state.coffee - 3) * 0.22)));
  function shake(level, ms) {
    if (reduced()) return;
    hookFrame();
    state.shakeLevel = level;
    state.shakeUntil = performance.now() + ms;
    effects().jitter = level;
  }

  // ---- helpers ----------------------------------------------------------------
  function resolvePlace(arg) {
    const a = arg.trim().toLowerCase().replace(/^\.\//, '').replace(/^~\//, '').replace(/\/+$/, '').replace(/\.(md|txt|sh|html?)$/, '');
    if (['', '~', '/', 'home', 'origin', '0', '(0,0)'].includes(a)) return 'hello';
    const p = places.find((pl) => pl.id === a || pl.label?.toLowerCase() === a);
    return p ? p.id : null;
  }

  function nearestPlace() {
    const cam = ctx.plane?.camera;
    if (!cam || !places.length) return { id: 'hello', x: 0, y: 0 };
    let best = places[0], bd = Infinity;
    for (const p of places) {
      const d = (p.x - cam.x) ** 2 + (p.y - cam.y) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return { id: best.id, x: cam.x, y: cam.y };
  }

  // core CSS: .mailto.is-glowing pulses 3×; restart it cleanly if it's already running
  function glowMail() {
    const el = $('#mailto') || $('#card-contact a[href^="mailto:"]');
    if (!el) return;
    clearTimeout(state.glowTimer);
    setTimeout(() => {
      el.classList.remove('is-glowing');
      void el.offsetWidth;
      el.classList.add('is-glowing');
      state.glowTimer = setTimeout(() => el.classList.remove('is-glowing'), 3600);
    }, reduced() ? 0 : 950);
  }

  function setInputPlaceholder(text) {
    const input = $('#input');
    if (!input) return;
    if (text == null) {
      if (state.savedPlaceholder != null) input.placeholder = state.savedPlaceholder;
      state.savedPlaceholder = null;
    } else {
      if (state.savedPlaceholder == null) state.savedPlaceholder = input.placeholder;
      input.placeholder = text;
    }
  }

  // ---- individual commands -----------------------------------------------------
  function help() {
    const cmds = ['ls', code('cd &lt;place&gt;'), 'pwd', 'whoami', 'hire', 'coffee', 'bug', 'flutter', 'party',
      'vim', code('sudo …'), 'rm -rf /', 'git push -f', 'npm i', 'clear', 'reset']
      .map((c) => (c.startsWith('<') ? c : btn(c)));
    const math = [btn('sin(x + t)'), btn('y = x^2/4'), btn('(2, 3)'), btn('z = sin(x)cos(y)')];
    toast(
      `<b>Commands:</b> ${dotted(cmds)}<br>` +
      `<b>Math:</b> ${dotted(math)}`,
      { html: true, kind: 'info', ms: 12000 },
    );
  }

  function ls(all) {
    const order = ['geogebra', 'mapplic', 'stack', 'contact', 'hello'];
    const items = order.filter((id) => places.some((p) => p.id === id) || !places.length)
      .map((id) => `<span style="color:${COLORS[id]}">${PLACE_FILES[id]}</span>`);
    const gap = '&nbsp;&nbsp; ';
    const hidden = all ? `<span style="opacity:.55">${['.', '..', '.coffee', '.bugs/', '.env (nice try)'].join(gap)}</span>${gap}` : '';
    toast(`<code>${hidden}${items.join(gap)}</code>`, { html: true, kind: 'info', ms: 6000 });
  }

  function cd(arg) {
    const a = arg.trim();
    if (a === '..' || a === '../') { home(); return toast('Up one level. It’s grid all the way up.'); }
    if (a === '-') { home(); return toast('cd -: there is no past. Only the origin.'); }
    const id = resolvePlace(a);
    if (!id) return toast(`cd: no such place: ${a}`, { kind: 'error' });
    fly(id);
    if (a === '/') toast('/ is (0, 0). Everything starts somewhere.');
  }

  function pwd() {
    const { id, x, y } = nearestPlace();
    const path = id === 'hello' ? '/home/guest' : `/home/guest/${id}`;
    toast(`${path}  ·  (${x.toFixed(1)}, ${y.toFixed(1)})`, { kind: 'info' });
  }

  function hire() {
    fly('contact');
    glowMail();
    toast(pick([
      'Excellent decision. The email button is glowing for you.',
      'Opening negotiations. Step 1: the glowing button.',
      'Smart. Write to balazs@codected.com — it’s glowing.',
    ]), { kind: 'success' });
  }

  function coffee() {
    hookFrame();
    state.coffee += 1;
    const n = state.coffee;
    if (n >= 6) {
      ctx.setAlgebraValue?.('coffee', String(n));
      shake(1, 900);
      toast(`coffee = ${n}. Decaf mode engaged.`);
      setTimeout(() => {
        state.coffee = 0;
        ctx.setAlgebraValue?.('coffee', '0');
      }, reduced() ? 0 : 900);
      return;
    }
    ctx.setAlgebraValue?.('coffee', String(n));
    const lines = {
      1: 'coffee = 1. Booting…',
      2: 'coffee = 2. Compiling thoughts.',
      3: 'coffee = 3. Optimal. Don’t push it.',
      4: 'coffee = 4. Productivity +12%. Hands −12%.',
      5: 'coffee = 5. I can hear the grid hum.',
    };
    toast(lines[n] || `coffee = ${n}.`);
  }

  function vimOn() {
    state.vim = true;
    state.vimWarned = false;
    bodyClass('is-vim', true);
    setInputPlaceholder(':q to exit (good luck)');
    toast('-- VIM -- You are now in vim. Good luck.', { kind: 'info', ms: 4200 });
  }
  function vimOff(cmd, { quiet = false } = {}) {
    state.vim = false;
    state.vimWarned = false;
    bodyClass('is-vim', false);
    setInputPlaceholder(null);
    if (quiet) return;
    toast(cmd === ':q!' ? 'Freedom. Changes discarded (there were none).' : 'Freedom.', { kind: 'success' });
  }

  // core CSS does the falling (body.is-collapsed); we narrate.
  async function rmrf() {
    if (state.collapsing) { toast('Already deleting. Patience.'); return; }
    state.collapsing = true;
    const t = toast('Deleting universe… 3%', { kind: 'error', ms: 2600 });
    bodyClass('is-collapsed', true);
    shake(0.45, 450);
    const steps = [[650, 'Deleting universe… 3%… 41%'], [1400, 'Deleting universe… 3%… 41%… 99%']];
    for (const [ms, msg] of steps) setTimeout(() => t?.update?.(msg), ms);
    await sleep(2600);
    bodyClass('is-collapsed', false);
    state.collapsing = false;
    t?.close?.();
    toast('…just kidding. Everything’s fine. Backups are a myth.', { kind: 'success' });
  }

  function bugs() {
    if (!ctx.fx?.spawnBugs) return toast('The bugs failed to load. Ironically, that is a bug.', { kind: 'error' });
    const n = ctx.fx.spawnBugs(7) ?? 0;
    if (!n) return toast('The bug tracker is full. Squash some first.');
    toast(reduced()
      ? `${n} bugs introduced. They’re sitting still (reduced motion). Click to squash.`
      : `${n} bugs introduced. Click to squash. Tests still pass.`);
  }

  function fixBugs() {
    const fixed = ctx.fx?.squashAll?.() ?? 0;
    if (!fixed) return toast('No bugs found. Which is what everyone says.');
    toast(`Fixed ${fixed}. Introduced 2. Standard sprint.`, { kind: 'success' });
    setTimeout(() => ctx.fx?.spawnBugs?.(2), reduced() ? 0 : 800);
  }

  function flutter() {
    if (reduced()) return toast('Flutter: the butterflies are resting (reduced motion). Hot reload later.');
    const n = ctx.fx?.butterflies?.(9) ?? 0;
    toast(n ? 'Flutter. Now with actual butterflies.' : 'Enough butterflies. This is a website, not a meadow.');
  }

  function party() {
    hookFrame();
    state.party = !state.party;
    bodyClass('is-party', state.party);
    if (state.party) {
      state.partyBurstAt = performance.now();
      if (!reduced()) ctx.fx?.confetti?.(140);
      toast(reduced() ? 'Party mode (quiet edition).' : 'Party mode. Deploying on a Friday.', { kind: 'success' });
    } else {
      effects().hue = 0;
      toast('Party’s over. Back to the backlog.');
    }
  }

  function light() {
    if (!reduced()) {
      bodyClass('is-flash', true);
      setTimeout(() => bodyClass('is-flash', false), 250);
    }
    setTimeout(() => toast('Light mode was deprecated in v2. Have you tried glowing?'), reduced() ? 0 : 260);
  }

  function matrix() {
    hookFrame();
    if (reduced()) return toast('Wake up, Neo. The grid has you.');
    state.matrixUntil = performance.now() + 5000;
    toast('Wake up, Neo. The grid has you.');
  }

  function clear() {
    ctx.clearUserObjects?.();
    toast('Cleared. Like it never happened.', { kind: 'info' });
  }

  function reset() {
    if (ctx.restoreDefaults) ctx.restoreDefaults(); else ctx.clearUserObjects?.();
    ctx.fx?.stopAll?.();
    if (state.vim) vimOff(null, { quiet: true });
    if (state.collapsing) { state.collapsing = false; bodyClass('is-collapsed', false); }
    if (state.party) { state.party = false; bodyClass('is-party', false); }
    state.matrixUntil = 0;
    state.coffee = 3;
    ctx.setAlgebraValue?.('coffee', '3');
    ctx.setAlgebraValue?.('bugs', '0');
    const fx = effects();
    fx.hue = 0; fx.jitter = 0;
    home();
    toast('Factory reset. Have you tried turning it off and on again? We just did.', { kind: 'info' });
  }

  function gitCmd(rest, rawRest = rest) {
    const r = rest.trim();
    if (!r) return toast('usage: git <command>. Try git push -f. Or don’t.', { kind: 'info' });
    if (/^push\s+(--force|-f)\b/.test(r) || /^push\s+.*(--force|-f)\b/.test(r)) {
      shake(0.7, 450);
      return toast('Force pushed. Somewhere, a coworker felt a disturbance.');
    }
    if (r === 'push') return toast('Everything up-to-date. Suspicious.');
    if (r === 'status') return toast('On branch master. Nothing to commit, working tree glowing.', { kind: 'info' });
    if (r.startsWith('blame')) return toast('git blame: every line — you, 3 a.m.');
    if (r.startsWith('commit')) {
      const msg = String(rawRest).match(/-m\s+["'“]?(.+?)["'”]?\s*$/i)?.[1];
      return toast(`[master 1337c0d] ${msg || 'fix: stuff'} · 1 file changed, 0 insertions(+), 9001 deletions(-)`);
    }
    if (/^(checkout|switch)\b/.test(r)) return toast('Switched to branch ‘main’. This repo uses master. Awkward.');
    if (r.startsWith('stash')) return toast('Saved working directory and index state WIP on master: your dignity');
    if (r.startsWith('add')) return toast('Staged. Like a demo.', { kind: 'info' });
    if (r.startsWith('diff')) return toast('+ glow  − boring', { kind: 'info' });
    if (r.startsWith('branch')) return toast('* master   (the only branch. We live dangerously.)', { kind: 'info' });
    if (r.startsWith('merge')) return toast('CONFLICT (content): Merge conflict in life.txt', { kind: 'error' });
    if (r.startsWith('clone')) return toast('Cloning into ‘codected’… it’s just HTML. Take it.');
    if (r.startsWith('pull')) return toast('Already up to date. Unlike the docs.');
    if (r.startsWith('rebase')) return toast('Rebasing… 1 of ∞ conflicts. Good luck.');
    if (r.startsWith('log')) return toast('a1b2c3d fix  ·  e4f5a6b fix again  ·  0ff1ce5 actually fix', { kind: 'info' });
    return toast(`git: '${r}' is not a git command. See 'git --help'.`);
  }

  // ---- command table --------------------------------------------------------------
  // exact: normalized string → handler.  prefix: [regex, handler(match)]
  const exact = new Map();
  const def = (names, fn) => names.forEach((n) => exact.set(n, fn));

  def(['help', '?', 'man', 'commands', '--help', '-h'], help);
  def(['ls', 'dir', 'll'], () => ls(false));
  def(['ls -a', 'ls -la', 'ls -al', 'ls -lah'], () => ls(true));
  def(['cd'], () => cd('~'));
  def(['pwd'], pwd);
  def(['whoami'], () => toast('guest@codected — but you’re welcome to stay.', { kind: 'info' }));
  def(['clear', 'cls'], clear);
  def(['reset', 'factory reset'], reset);
  def(['home', 'origin'], () => { home(); toast('There’s no place like (0, 0).', { kind: 'info' }); });
  def(['hire', 'hire me', 'hire(me)', 'hire(me) = true', 'contact', 'email', 'contact me', 'mail'], hire);
  def(['mailto', 'send email', 'write'], () => { ctx.openMail?.(); toast('Opening your mail app. Be nice.', { kind: 'info' }); });
  def(['coffee', 'brew coffee', 'make coffee', 'brew', 'espresso', 'more coffee', 'coffee++'], coffee);
  def(['tea'], () => toast('This is a coffee-driven codebase. Tea is a feature request.'));
  def(['vim', 'vi', 'nvim', 'vim .'], vimOn);
  def(['emacs'], () => toast('Great operating system. Lacks a decent editor.'));
  def(['nano'], () => toast('Respectable. Ctrl+X to exit. See? Not that hard, vim.'));
  def(['rm -rf', 'rm -rf /', 'rm -rf *', 'rm -rf ~', 'rm -rf .', 'rm -fr /', 'sudo rm -rf /', 'sudo rm -rf', 'rm -rf /*', 'sudo rm -rf /*', 'rm -rf --no-preserve-root /'], rmrf);
  def(['bug', 'bugs', 'spawn bugs', 'add bug', 'add bugs'], bugs);
  def(['debug', 'fix bugs', 'fix', 'squash', 'fix bug'], fixBugs);
  def(['flutter', 'butterfly', 'butterflies', 'flutter run'], flutter);
  def(['flutter doctor'], () => toast('[✓] Flutter  [✓] Coffee  [!] Sleep (not found)', { kind: 'info' }));
  def(['party', 'disco', 'party mode', 'celebrate', 'confetti'], party);
  def(['light', 'light mode', 'lightmode', 'theme light', 'light theme'], light);
  def(['dark', 'dark mode', 'darkmode', 'theme dark', 'dark theme'], () => toast('Already as dark as it gets.'));
  def(['42', 'answer', 'the answer', 'the answer to life the universe and everything'], () => toast('Correct. Now, what was the question?'));
  def(['exit', 'quit', 'logout', 'bye', ':q', ':q!', ':wq', ':x', 'ctrl+c', '^c'], () => toast('There is no exit. Only more grid.'));
  def(['hello', 'hi', 'hey', 'hola', 'yo', 'sup', 'szia', 'salut', 'buna'], () => toast(pick([
    'Hi. You found the input bar. Most people just scroll.',
    'Hello, world. Wait — that’s my line.',
    'Hey. Try typing sin(x), or help.',
  ]), { kind: 'info' }));
  def(['npm install', 'npm i', 'npm ci', 'yarn', 'yarn install', 'pnpm i', 'pnpm install', 'bun install', 'bun i'],
    () => toast('added 0 packages, audited 0 packages in 0s. This site has zero dependencies. Feels good.', { kind: 'success' }));
  def(['make'], () => toast('make: *** No rule to make target ‘sense’. Stop.', { kind: 'error' }));
  def(['make me a sandwich'], () => toast('What? Make it yourself.'));
  def(['sudo make me a sandwich'], () => toast('Okay.', { kind: 'success' }));
  def(['ping'], () => toast('pong', { kind: 'info' }));
  def(['pong'], () => toast('ping. Your serve.'));
  def(['matrix', 'neo', 'the matrix', 'red pill'], matrix);
  def(['blue pill'], () => toast('You wake up in your bed. The grid is still here.'));
  def(['geogebra'], () => fly('geogebra'));
  def(['mapplic'], () => fly('mapplic'));
  def(['stack', 'skills', 'tech', 'languages'], () => fly('stack'));
  def(['about', 'about me', 'balazs', 'balázs'], () => fly('hello'));
  def(['cat'], () => toast('=^.^=  meow.'));
  def(['date'], () => toast(new Date().toString().replace(/ \(.+\)$/, '') + ' — a fine day to ship.', { kind: 'info' }));
  def(['uptime'], () => toast('up since you got here. load average: 0.00, 0.01, coffee', { kind: 'info' }));
  def(['history'], () => toast('Use ↑ and ↓. History repeats itself.', { kind: 'info' }));
  def(['xyzzy'], () => toast('Nothing happens.'));
  def(['hack', 'hack the planet', 'hacker', 'hackerman'], () => toast('Access granted. To nothing. It’s a static site.'));
  def(['undo', 'ctrl+z', 'cmd+z'], () => toast('Undo is not available in production.'));
  def(['duck', 'rubber duck', 'quack'], () => toast('Quack. Now explain the bug to me slowly.'));
  def(['why', 'why?'], () => toast('Because GeoGebra and Mapplic deserved a tribute. And because I could.'));
  def(['neofetch', 'uname', 'uname -a', 'fastfetch'], () => toast(
    `<code><b style="color:#3df5ff">guest@codected</b><br>OS: The Plane (ℝ²)<br>Shell: GeoGebra-ish<br>Deps: 0<br>Uptime: since you arrived<br>Theme: glowing (only option)</code>`,
    { html: true, kind: 'info', ms: 7000 },
  ));

  // his stack, typed by people who know it
  def(['swift'], () => toast('error: the compiler is unable to type-check this expression in reasonable time', { kind: 'error' }));
  def(['kotlin'], () => toast('val bugs: Int? = null — safe call. Nothing crashed. Suspicious.', { kind: 'info' }));
  def(['java'], () => toast('AbstractSingletonProxyFactoryBean created. Took 4 s. Kotlin says hi.'));
  def(['objective-c', 'objc', 'obj-c'], () => toast('[[Balazs alloc] initWithBrackets:YES]; // still ships'));
  def(['typescript', 'ts', 'tsc'], () => toast('Type \'Balázs\' is assignable to type \'AnyStack\'. 0 errors. Suspiciously strict.', { kind: 'success' }));
  def(['javascript', 'js'], () => toast('[] + {} → "[object Object]". I can explain. Please don’t ask me to.'));
  def(['sql'], () => toast('SELECT * FROM skills WHERE shipped = true; — 1 row: everything.', { kind: 'info' }));
  def(['backend', 'api', 'apis', 'fullstack', 'full stack', 'full-stack'], () => toast('200 OK — frontend, backend, the database, and the cron job nobody remembers.', { kind: 'success' }));
  def(['anything', 'everything', 'infinity', '∞', '…∞'], () => toast('for (const lang of Infinity) learn(lang) — still running. Name one; I’ve probably shipped it.'));
  def(['dart'], () => toast('Hot reload complete. Nothing changed, but it changed fast.'));
  def(['xcode'], () => toast('Indexing… (2 of ∞). Have you tried deleting DerivedData?'));
  def(['gradle', 'gradlew', './gradlew', './gradlew build', 'gradle build'], () => { toast('Gradle sync started. Get a coffee.'); setTimeout(coffee, 1200); });
  def(['pod install', 'pod update'], () => toast('Pod installation complete! Podfile.lock changed. Nobody knows why.', { kind: 'success' }));
  def(['adb devices'], () => toast('List of devices attached: emulator-5554 offline (as usual)', { kind: 'info' }));

  // things people type into anything that looks like a terminal
  def(['sl'], () => {
    toast('<span class="sl" aria-hidden="true">🚂🚃🚃💨</span> You meant ls. Here’s a train anyway.', { html: true });
    setTimeout(() => ls(false), reduced() ? 0 : 1600);
  });
  def(['fortune'], () => toast(pick([
    'It works on my machine.',
    'There are 2 hard problems: cache invalidation, naming things, and off-by-one errors.',
    'The bug is in the code you’re sure is fine.',
    'Weeks of coding can save you hours of planning.',
    'Today’s lucky number: NaN.',
  ]), { kind: 'info' }));
  def(['exit()', 'quit()', 'ctrl-c', 'ctrl+d', 'ctrl-d', '^d', ':qa!'], exact.get('exit'));
  def(['reboot', 'shutdown', 'shutdown now', 'sudo reboot'], reset);

  // conversation
  def(['help me', 'help pls', 'help please', 'halp'], help);
  def(['thanks', 'thank you', 'ty', 'thx'], () => toast('You’re welcome. That’s 0 bugs and 1 thank-you in prod.', { kind: 'success' }));
  def(['resume', 'cv', 'résumé'], () => {
    toast('No PDF. The boring version is the CV.', { kind: 'info' });
    if (!ctx.isBoring?.()) ctx.setBoring?.(true);
  });
  def(['konami', 'cheat', 'cheats'], () => toast('Not like that. Click the plane, then use the arrow keys.', { kind: 'info' }));
  def(['nan'], () => toast('NaN === NaN → false. Even NaN doesn’t know NaN.'));
  def(['null', 'undefined'], () => toast('Billion-dollar mistake detected. Plotting nothing, carefully.'));
  def(['tabs', 'spaces', 'tabs vs spaces', 'tabs or spaces'], () => toast('Spaces. This plane has infinitely many.'));
  def(['lol', 'lmao', 'haha'], () => toast('I’ll be here all week. Literally, it’s a static site.'));

  function cowsay(msg) {
    const said = [...msg.trim()].slice(0, 32).join('') || 'Moo. Hire Balázs.';
    const t = esc(said);
    const l = [...said].length + 2;
    toast(`<pre class="cow"> ${'_'.repeat(l)}\n&lt; ${t} &gt;\n ${'-'.repeat(l)}\n        \\   ^__^\n         \\  (oo)\\_______\n            (__)\\       )\\/\\\n                ||----w |\n                ||     ||</pre>`,
      { html: true, kind: 'info', ms: 7000 });
  }

  const prefix = [
    [/^cd\s+(.+)$/, (m) => cd(m[1])],
    [/^(vim|vi|nvim)\s+.+$/, () => vimOn()],
    [/^(cat|open|less|more|code|start)\s+(.+)$/, (m) => {
      const id = resolvePlace(m[2]);
      if (!id) return toast(`${m[1]}: ${m[2]}: No such file or directory`, { kind: 'error' });
      fly(id);
    }],
    [/^(sudo\s+)+(rm\s+-(rf|fr)\b.*)$/, () => rmrf()],
    [/^sudo(\s+.*)?$/, () => toast('Nice try. This incident will be reported to /dev/null.')],
    [/^rm\s+-(rf|fr)\b.*$/, () => rmrf()],
    [/^rm\s+.+$/, () => toast('rm: permission denied. Try being more destructive (-rf).')],
    [/^git(\s+.*)?$/, (m, raw) => gitCmd(m[1] || '', raw.replace(/^git\s*/i, ''))],
    [/^(npm|yarn|pnpm|bun)\s+(install|i|add|ci)\b.*$/, () => exact.get('npm i')()],
    [/^(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve)$/, () => toast('Already running. You’re looking at it.', { kind: 'success' })],
    [/^(npm|yarn|pnpm|bun)\s+(run\s+)?test$/, () => toast('✓ it renders. 1 passing. That’s the whole suite.', { kind: 'success' })],
    [/^(npm|yarn|pnpm|bun)\s+(run\s+)?build$/, () => toast('No build step. Nothing to build. That was the build.', { kind: 'info' })],
    [/^npm\s+audit\b.*$/, () => toast('found 0 vulnerabilities (in 0 packages)', { kind: 'success' })],
    [/^(npm|yarn|pnpm|bun)$/, (m) => toast(`Usage: ${m[1]} <command>. Try ${m[1]} i — it’s very fast here.`, { kind: 'info' })],
    [/^make\s+(.+)$/, (m) => toast(`make: *** No rule to make target ‘${m[1]}’. Stop.`, { kind: 'error' })],
    [/^(ping)\s+.+$/, () => toast('pong — 0 ms. It’s all local. It’s a static site.', { kind: 'info' })],
    [/^(hire|contact|email)\s+.+$/, () => hire()],
    [/^man\s+(.+)$/, (m) => toast(`No manual entry for ${m[1]}. Try help — it’s shorter.`, { kind: 'info' })],
    [/^cowsay(\s.*)?$/, (m, raw) => cowsay(raw.replace(/^cowsay\s*/i, ''))],
    // shell commands: a shell-shaped answer, not a math error (multi-letter names only, so math stays math)
    [/^(top|htop|btop)$/, () => toast('<code>PID 1 coffee 98% · PID 2 grid 2% · PID 3 you 0% (idle)</code>', { html: true, kind: 'info' })],
    [/^(kill|killall|pkill)(\s.*)?$/, () => toast('kill: (1): Operation not permitted. The grid is PID 1.', { kind: 'error' })],
    [/^ssh(\s.*)?$/, () => toast('Permission denied (publickey). Email needs no keys: type hire.', { kind: 'error' })],
    [/^docker(\s.*)?$/, () => toast('Cannot connect to the Docker daemon. This site is one folder. It doesn’t need a container.', { kind: 'error' })],
    [/^kubectl(\s.*)?$/, () => toast('error: a static site does not need 3 replicas.', { kind: 'error' })],
    [/^(curl|wget)(\s.*)?$/, () => toast('HTTP/2 200 · content-type: text/html · you’re looking at it.', { kind: 'info' })],
    [/^python3?$/, () => toast('>>> import antigravity — you’re already floating on an infinite plane.')],
    [/^node$/, () => toast('> 0.1 + 0.2 → 0.30000000000000004. (Type 0.1+0.2 here. The plane says 0.3.)')],
    [/^(apt|apt-get|brew|pip3?|chmod|chown|touch|mkdir|rmdir|grep|which|export|source|systemctl|crontab|ifconfig|traceroute|tar|unzip|ruby|cargo|rustc|gcc|javac|deno)(\s|$)/,
      (m) => toast(`${m[1]}: command not found. This shell only speaks math and nonsense. Try help.`, { kind: 'error' })],
  ];

  const ECHO_VARS = { $PATH: '/usr/local/coffee/bin:/home/guest/plane', $USER: 'guest', $HOME: '(0, 0)', $SHELL: '/bin/geogebra-ish', $EDITOR: 'vim (send help)' };

  // lowercase, collapse spaces, drop trailing "!"/"." and a leading "/" before a word ("/help", "hire me!")
  function normalize(text) {
    let s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (s.length > 1) s = s.replace(/(?<=[a-z)])[!.]+$/, '').replace(/^\/(?=[a-z])/, '');
    return s;
  }

  function run(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase().replace(/\s+/g, ' ');

    // vim swallows everything. That's the point of vim.
    if (state.vim) {
      if (lower === ':q' && !state.vimWarned) {
        state.vimWarned = true;
        toast('E37: No write since last change (add ! to override)', { kind: 'error' });
      } else if (VIM_EXITS.has(lower)) vimOff(lower);
      else if (lower === 'i' || lower === 'a') toast('-- INSERT -- …it’s [readonly]. Nice try.', { kind: 'info' });
      else if (lower === ':help' || lower === ':h') toast('Nobody has ever read :help. Try :q!', { kind: 'info' });
      else toast(`E492: Not an editor command: ${raw.slice(0, 40)}`, { kind: 'error' });
      return true;
    }

    // echo keeps your case and punctuation (and knows a few env vars)
    const em = raw.match(/^echo\s+(.+)$/i);
    if (em) {
      const out = em[1].replace(/\$[A-Z_]+/g, (v) => ECHO_VARS[v] ?? '').replace(/^(["'])(.*)\1$/, '$2');
      toast(out || ' ', { kind: 'info' });
      return true;
    }

    const s = normalize(raw);
    const fn = exact.get(s) || exact.get(lower);
    if (fn) { fn(); return true; }
    for (const [re, handler] of prefix) {
      const m = s.match(re);
      if (m) { handler(m, raw); return true; }
    }
    return false;
  }

  // keep the `bugs = n` algebra line honest
  ctx.fx?.onBugsChanged?.((remaining, squashed, reason) => {
    ctx.setAlgebraValue?.('bugs', String(remaining));
    if (remaining === 0 && squashed > 0 && reason === 'squash') {
      toast('0 bugs. In production? Probably.', { kind: 'success' });
    }
  });

  return { run, get vim() { return state.vim; } };
}

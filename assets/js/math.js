// math.js — a tiny, honest expression engine for the plane.
// Tokenizer → Pratt parser → AST → closure tree. No eval, no Function constructor, no DOM.
//
//   parseInput("sin(x)")            → { kind: 'fn2d',  name: 'f', label: 'f(x) = sin(x)', f(x, t) }
//   parseInput("z = sin(x)cos(y)")  → { kind: 'fn3d',  name: 'f', label: 'f: z = sin(x)·cos(y)', f(x, y, t) }
//   parseInput("A = (pi/2, √2)")    → { kind: 'point', name: 'A', label: 'A = (π / 2, √2)', x, y }
//   parseInput("2 + 2")             → { kind: 'value', name: 'a', label: 'a = 4', value: 4 }
//   compile("x^2 + t")              → (scope) => number

export class MathError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = 'MathError';
    if (pos !== undefined) this.pos = pos;
  }
}

const MAX_LEN = 1000;
const MAX_DEPTH = 100;

// ───────────────────────────── numeric helpers ─────────────────────────────

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function factorial(n) {
  if (Number.isNaN(n)) return NaN;
  if (Number.isInteger(n)) {
    if (n < 0) return NaN;
    if (n > 170) return Infinity;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }
  return gamma(n + 1);
}

function gamma(z) {
  if (Number.isNaN(z)) return NaN;
  if (z === Infinity) return Infinity;
  if (Number.isInteger(z)) return z <= 0 ? NaN : factorial(z - 1);
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

// x^(1/3) for negative x should be real (GeoGebra agrees). Odd-denominator rationals only.
function pow(b, e) {
  const r = Math.pow(b, e);
  if (b < 0 && Number.isNaN(r) && Number.isFinite(e)) {
    for (let q = 3; q <= 99; q += 2) {
      const p = e * q;
      const pr = Math.round(p);
      if (Math.abs(p - pr) < 1e-9) {
        const m = Math.pow(-b, e);
        return pr % 2 === 0 ? m : -m;
      }
    }
  }
  return r;
}

function nroot(x, n) {
  if (!Number.isFinite(n) || n === 0) return NaN;
  if (x < 0 && Number.isInteger(n) && Math.abs(n) % 2 === 1) return -Math.pow(-x, 1 / n);
  return Math.pow(x, 1 / n);
}

const mod = (a, b) => (b === 0 ? NaN : a - b * Math.floor(a / b));
const sign = (x) => Math.sign(x);
const log10 = (x) => Math.log10(x);
const logb = (b, x) => Math.log(x) / Math.log(b);

// ───────────────────────────── vocabulary ─────────────────────────────

// canonical name → { fn, min, max (arity), show (display name) }
const FUNCS = {
  sin: { fn: Math.sin, show: 'sin' },
  cos: { fn: Math.cos, show: 'cos' },
  tan: { fn: Math.tan, show: 'tan' },
  sec: { fn: (x) => 1 / Math.cos(x), show: 'sec' },
  csc: { fn: (x) => 1 / Math.sin(x), show: 'csc' },
  cot: { fn: (x) => 1 / Math.tan(x), show: 'cot' },
  asin: { fn: Math.asin, show: 'sin⁻¹' },
  acos: { fn: Math.acos, show: 'cos⁻¹' },
  atan: { fn: Math.atan, show: 'tan⁻¹' },
  sinh: { fn: Math.sinh, show: 'sinh' },
  cosh: { fn: Math.cosh, show: 'cosh' },
  tanh: { fn: Math.tanh, show: 'tanh' },
  asinh: { fn: Math.asinh, show: 'sinh⁻¹' },
  acosh: { fn: Math.acosh, show: 'cosh⁻¹' },
  atanh: { fn: Math.atanh, show: 'tanh⁻¹' },
  atan2: { fn: Math.atan2, min: 2, max: 2, show: 'atan2' },
  sqrt: { fn: Math.sqrt, show: '√' },
  cbrt: { fn: Math.cbrt, show: '∛' },
  nroot: { fn: nroot, min: 2, max: 2, show: 'nroot' },
  abs: { fn: Math.abs, show: 'abs' },
  exp: { fn: Math.exp, show: 'exp' },
  ln: { fn: Math.log, show: 'ln' },
  log: { fn: log10, min: 1, max: 2, fn2: logb, show: 'log' },
  log2: { fn: Math.log2, show: 'log₂' },
  floor: { fn: Math.floor, show: 'floor' },
  ceil: { fn: Math.ceil, show: 'ceil' },
  round: { fn: Math.round, show: 'round' },
  sign: { fn: sign, show: 'sgn' },
  min: { fn: Math.min, min: 1, max: Infinity, show: 'min' },
  max: { fn: Math.max, min: 1, max: Infinity, show: 'max' },
  mod: { fn: mod, min: 2, max: 2, show: 'mod' },
  gamma: { fn: gamma, show: 'Γ' },
};
for (const k in FUNCS) {
  FUNCS[k].min ??= 1;
  FUNCS[k].max ??= 1;
}

const FUNC_ALIASES = {
  arcsin: 'asin', arccos: 'acos', arctan: 'atan',
  arsinh: 'asinh', arcosh: 'acosh', artanh: 'atanh',
  arcsinh: 'asinh', arccosh: 'acosh', arctanh: 'atanh',
  sgn: 'sign', lg: 'log', log10: 'log', root: 'nroot',
};

const INVERSE = { sin: 'asin', cos: 'acos', tan: 'atan', sinh: 'asinh', cosh: 'acosh', tanh: 'atanh' };

// canonical constant → { value, show }
const CONSTS = {
  pi: { value: Math.PI, show: 'π' },
  tau: { value: 2 * Math.PI, show: 'τ' },
  e: { value: Math.E, show: 'e' },
  phi: { value: (1 + Math.sqrt(5)) / 2, show: 'φ' },
  inf: { value: Infinity, show: '∞' },
};
const CONST_ALIASES = { infinity: 'inf' };
const CONST_SYMBOLS = { 'π': 'pi', 'τ': 'tau', 'φ': 'phi', 'ϕ': 'phi', '∞': 'inf' };

// Multi-letter names the tokenizer can pull out of a run of letters (lowercase).
const WORDS = new Map();
for (const k in FUNCS) WORDS.set(k, { kind: 'func', name: k });
for (const k in FUNC_ALIASES) WORDS.set(k, { kind: 'func', name: FUNC_ALIASES[k] });
for (const k in CONSTS) if (k.length > 1) WORDS.set(k, { kind: 'const', name: k });
for (const k in CONST_ALIASES) WORDS.set(k, { kind: 'const', name: CONST_ALIASES[k] });
const MAX_WORD = Math.max(...[...WORDS.keys()].map((w) => w.length));

const OP_CHARS = {
  '+': '+', '-': '-', '−': '-', '–': '-', '*': '*', '×': '*', '·': '*', '⋅': '*', '∙': '*', '•': '*',
  '/': '/', '÷': '/', '^': '^', '!': '!', '(': '(', ')': ')', ',': ',', '|': '|', '=': '=',
  '⌊': '⌊', '⌋': '⌋', '⌈': '⌈', '⌉': '⌉',
};
const BRACKETS = { '⌊': ['⌋', 'floor'], '⌈': ['⌉', 'ceil'] };
const SUP_IN = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
const SUP_VARS = { 'ˣ': 'x', 'ʸ': 'y', 'ᵗ': 't' };
const SUP_OUT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻', x: 'ˣ', y: 'ʸ', t: 'ᵗ' };

const isLetter = (ch) => /\p{L}/u.test(ch);

// ───────────────────────────── tokenizer ─────────────────────────────

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const push = (tok) => toks.push(tok);
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }

    // numbers: 12, 1.5, .5, 1e3, 2.5E-4
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new MathError("A lonely '.' — numbers like .5 need digits.", i);
      const text = m[0];
      if (src[i + text.length] === '.') {
        const bad = /^[0-9.]+/.exec(src.slice(i))[0];
        throw new MathError(`'${bad}' has too many dots. Pick one.`, i);
      }
      push({ t: 'num', v: Number(text), pos: i });
      i += text.length;
      continue;
    }

    // superscripts: x² → x^2, x⁻¹ → x^-1, eˣ → e^x, e⁻ˣ → e^-x
    if (ch in SUP_IN || ch in SUP_VARS || ch === '⁻') {
      push({ t: 'op', v: '^', pos: i });
      if (ch === '⁻') { push({ t: 'op', v: '-', pos: i }); i++; }
      if (src[i] in SUP_VARS) {
        push({ t: 'id', kind: 'var', name: SUP_VARS[src[i]], word: SUP_VARS[src[i]], pos: i });
        i++;
        continue;
      }
      let digits = '';
      while (i < n && src[i] in SUP_IN) digits += SUP_IN[src[i++]];
      if (!digits) throw new MathError('A superscript minus with nothing after it. Mysterious.', i);
      push({ t: 'num', v: Number(digits), pos: i });
      continue;
    }

    if (ch === "'" || ch === '′' || ch === '″') {
      throw new MathError("Derivatives are GeoGebra's department. I just draw.", i);
    }

    // ** → ^
    if (ch === '*' && src[i + 1] === '*') { push({ t: 'op', v: '^', pos: i }); i += 2; continue; }

    if (ch === '<' || ch === '>' || ch === '≤' || ch === '≥' || ch === '≠' || (ch === '!' && src[i + 1] === '=')) {
      throw new MathError('No inequalities here — everyone is equal on this plane.', i);
    }
    if (ch === '=' && src[i + 1] === '=') throw new MathError("This isn't JavaScript. One '=' will do.", i);

    if (ch in OP_CHARS) { push({ t: 'op', v: OP_CHARS[ch], pos: i }); i++; continue; }

    if (ch === 'Γ') {
      push({ t: 'id', kind: 'func', name: 'gamma', word: ch, pos: i });
      i++;
      continue;
    }

    if (ch === '√' || ch === '∛') {
      push({ t: 'id', kind: 'func', name: ch === '√' ? 'sqrt' : 'cbrt', prefix: true, word: ch, pos: i });
      i++;
      continue;
    }

    if (ch in CONST_SYMBOLS) {
      push({ t: 'id', kind: 'const', name: CONST_SYMBOLS[ch], word: ch, pos: i });
      i++;
      continue;
    }

    // ASCII letter runs are split greedily into known names, else single letters.
    if (/[A-Za-z]/.test(ch)) {
      const run = /^[A-Za-z]+/.exec(src.slice(i))[0];
      const start = i;
      const pieces = [];
      let j = 0;
      while (j < run.length) {
        let hit = null;
        for (let L = Math.min(MAX_WORD, run.length - j); L >= 2; L--) {
          const w = WORDS.get(run.slice(j, j + L).toLowerCase());
          if (w) { hit = { ...w, len: L }; break; }
        }
        if (hit) {
          pieces.push({ t: 'id', kind: hit.kind, name: hit.name, word: run, pos: start + j });
          j += hit.len;
        } else {
          const c = run[j];
          if (c === 'e') pieces.push({ t: 'id', kind: 'const', name: 'e', word: run, pos: start + j });
          else pieces.push({ t: 'id', kind: 'var', name: c, word: run, pos: start + j });
          j++;
        }
      }
      i += run.length;
      // log2(…), log10(…), atan2(…): the digits belong to the name.
      const digits = /^(?:\d+|[₀-₉]+)/.exec(src.slice(i));
      const last = pieces[pieces.length - 1];
      if (digits && last.kind === 'func') {
        const plain = [...digits[0]].map((c) => (c >= '₀' && c <= '₉' ? String(c.charCodeAt(0) - 0x2080) : c)).join('');
        const raw = run.slice(last.pos - start) + plain;
        const w = WORDS.get(raw.toLowerCase());
        if (w) { last.name = w.name; last.word = raw; i += digits[0].length; }
      }
      // "foo(x)": remember that the whole word was used like a function
      if (/^\s*\(/.test(src.slice(i))) for (const p of pieces) p.wordCall = true;
      toks.push(...pieces);
      continue;
    }

    // Other letters (θ, α, …) become unknown variables and get a nice error later.
    if (isLetter(ch)) {
      push({ t: 'id', kind: 'var', name: ch, word: ch, pos: i });
      i++;
      continue;
    }

    throw new MathError(`Unexpected '${String.fromCodePoint(src.codePointAt(i))}'. I don't know what that is, and I'm afraid to ask.`, i);
  }
  toks.push({ t: 'eof', pos: n });
  return toks;
}

// ───────────────────────────── parser (Pratt) ─────────────────────────────

const BP_ADD = 10;
const BP_MUL = 20;
const BP_UNARY = 25;
const BP_POW = 30;
const BP_FACT = 40;
const UNBALANCED = 'Unbalanced parentheses — happens to the best of us.';
const UNCLOSED_ABS = 'An |absolute value| never got closed. Absolutely tragic.';

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.i = 0;
    this.depth = 0;
    // mode stack: abs = '|' in infix position closes; chain = function-argument without parens
    this.modes = [{ abs: false, chain: false }];
  }
  get mode() { return this.modes[this.modes.length - 1]; }
  peek(k = 0) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  next() { return this.toks[this.i++] ?? this.toks[this.toks.length - 1]; }
  prev() { return this.toks[this.i - 2]; }
  is(tok, v) { return tok.t === 'op' && tok.v === v; }

  startsOperand(tok) {
    if (tok.t === 'num' || tok.t === 'id') return true;
    if (tok.t !== 'op') return false;
    return tok.v === '(' || tok.v in BRACKETS || (tok.v === '|' && !this.mode.abs);
  }

  lbp(tok) {
    if (tok.t === 'op') {
      switch (tok.v) {
        case '+': case '-': return BP_ADD;
        case '*': case '/': return BP_MUL;
        case '^': return BP_POW;
        case '!': return BP_FACT;
        case '(': case '⌊': case '⌈': return this.implicitBp(tok);
        case '|': return this.mode.abs ? 0 : this.implicitBp(tok);
        default: return 0; // ) , = eof
      }
    }
    if (tok.t === 'num' || tok.t === 'id') return this.implicitBp(tok);
    return 0;
  }

  // Implicit multiplication. Inside "sin 2x" style arguments it binds a hair tighter than
  // explicit * and /, and stops before the next function name (so "sin x cos x" works).
  implicitBp(tok) {
    if (!this.mode.chain) return BP_MUL;
    if (tok.t === 'id' && tok.kind === 'func') return 0;
    return BP_MUL + 1;
  }

  parseExpr(rbp = 0) {
    if (++this.depth > MAX_DEPTH) throw new MathError('Too deeply nested. Inception called; it wants its parentheses back.');
    let left = this.nud(this.next());
    for (;;) {
      const tok = this.peek();
      if (this.lbp(tok) <= rbp) break;
      left = this.led(tok, left);
    }
    this.depth--;
    return left;
  }

  led(tok, left) {
    if (tok.t === 'op') {
      switch (tok.v) {
        case '+': case '-':
          this.next();
          return { type: 'bin', op: tok.v, left, right: this.parseExpr(BP_ADD) };
        case '*': case '/':
          this.next();
          return { type: 'bin', op: tok.v, left, right: this.parseExpr(BP_MUL) };
        case '^':
          this.next();
          return { type: 'bin', op: '^', left, right: this.parseExpr(BP_POW - 1) };
        case '!':
          this.next();
          return { type: 'fact', arg: left };
      }
    }
    // implicit multiplication: do not consume, the operand's nud will.
    const bp = this.implicitBp(tok);
    return { type: 'bin', op: '*', implicit: true, left, right: this.parseExpr(bp) };
  }

  nud(tok) {
    if (tok.t === 'num') return { type: 'num', value: tok.v };
    if (tok.t === 'id') {
      if (tok.kind === 'const') return { type: 'const', name: tok.name };
      if (tok.kind === 'func') return this.parseCall(tok);
      const callLike = this.is(this.peek(), '(');
      return { type: 'var', name: tok.name, word: tok.word, callLike, wordCall: !!tok.wordCall, pos: tok.pos };
    }
    if (tok.t === 'eof') {
      const p = this.prev();
      if (p && p.t === 'op' && p.v === '|') throw new MathError('A stray |. Absolute values come in pairs.', tok.pos);
      if (p && p.t === 'op') throw new MathError(`It ends right after '${p.v}'. Cliffhanger.`, tok.pos);
      throw new MathError('Empty input. Bold minimalism.', tok.pos);
    }
    switch (tok.v) {
      case '-': return { type: 'neg', arg: this.parseExpr(BP_UNARY) };
      case '+': return this.parseExpr(BP_UNARY);
      case '(': return this.parseGroup(tok);
      case '|': {
        this.modes.push({ abs: true, chain: false });
        const arg = this.parseExpr(0);
        if (!this.is(this.peek(), '|')) throw new MathError(UNCLOSED_ABS, tok.pos);
        this.next();
        this.modes.pop();
        return { type: 'call', name: 'abs', args: [arg] };
      }
      case '⌊': case '⌈': {
        const [closer, fname] = BRACKETS[tok.v];
        this.modes.push({ abs: false, chain: false });
        const arg = this.parseExpr(0);
        if (!this.is(this.peek(), closer)) throw new MathError(`That ${tok.v} never got its ${closer}. Brackets come in pairs.`, tok.pos);
        this.next();
        this.modes.pop();
        return { type: 'call', name: fname, args: [arg] };
      }
      case ')': case '⌋': case '⌉': throw new MathError(UNBALANCED, tok.pos);
      case ',': throw new MathError('Unexpected comma. Points need parentheses: (1, 2).', tok.pos);
      case '=': throw new MathError("Unexpected '='. One '=' is plenty.", tok.pos);
      default: {
        const start = this.i === 1;
        throw new MathError(`Unexpected '${tok.v}'${start ? ' at the start' : ''}. It needs something on its left.`, tok.pos);
      }
    }
  }

  parseList(open) {
    this.modes.push({ abs: false, chain: false });
    if (this.is(this.peek(), ')')) throw new MathError('Empty parentheses. Very zen, but not math.', open.pos);
    const items = [this.parseExpr(0)];
    while (this.is(this.peek(), ',')) {
      this.next();
      items.push(this.parseExpr(0));
    }
    const close = this.peek();
    if (!this.is(close, ')')) {
      if (close.t === 'eof') throw new MathError(UNBALANCED, open.pos);
      if (this.is(close, '|')) throw new MathError('Parentheses and |bars| got tangled. Untangle, retry.', close.pos);
      if (this.is(close, '=')) throw new MathError("An '=' inside parentheses? Bold. No.", close.pos);
      throw new MathError(UNBALANCED, close.pos);
    }
    this.next();
    this.modes.pop();
    return items;
  }

  parseGroup(open) {
    const items = this.parseList(open);
    if (items.length === 1) return items[0];
    return { type: 'tuple', items, pos: open.pos };
  }

  parseCall(tok) {
    let name = tok.name;
    const show = FUNCS[name].show;
    if (tok.prefix) {
      // √x, √(x+1), √2x = √2·x
      const nt = this.peek();
      if (!this.startsOperand(nt) && !this.is(nt, '-') && !this.is(nt, '+')) {
        throw new MathError(`${show} of what? Try ${show}(2).`, tok.pos);
      }
      return { type: 'call', name, args: [this.parseExpr(BP_UNARY)] };
    }

    // sin²(x), sin^2 x, sin^-1(x) (= asin)
    let power = null;
    if (this.is(this.peek(), '^')) {
      const a = this.peek(1);
      const b = this.peek(2);
      if (a.t === 'num') { this.i += 2; power = a.v; }
      else if (this.is(a, '-') && b.t === 'num') { this.i += 3; power = -b.v; }
      if (power === -1 && INVERSE[name]) { name = INVERSE[name]; power = null; }
    }

    const spec = FUNCS[name];
    let args;
    const nt = this.peek();
    if (this.is(nt, '(')) {
      this.next();
      args = this.parseList(nt);
    } else if (this.startsOperand(nt) || this.is(nt, '-')) {
      // "sin x", "sin 2x", "ln x²": argument without parentheses
      this.modes.push({ abs: this.mode.abs, chain: true });
      args = [this.parseExpr(BP_MUL)];
      this.modes.pop();
    } else {
      throw new MathError(`${tok.word.length > 1 ? tok.word : show} of what? Give it an argument, like ${spec.show === '√' ? 'sqrt' : name}(x).`, tok.pos);
    }

    if (args.length < spec.min || args.length > spec.max) {
      const want = spec.min === spec.max ? `${spec.min}` : spec.max === Infinity ? `at least ${spec.min}` : `${spec.min} or ${spec.max}`;
      const s = spec.max === 1 && spec.min === 1 ? '' : 's';
      throw new MathError(`${spec.show}() wants ${want} argument${s}, you gave ${args.length}.${args.length > spec.max ? ' Generous, but no.' : ''}`, tok.pos);
    }
    for (const a of args) if (a.type === 'tuple') throw new MathError(`${spec.show}() wants numbers, not points.`, tok.pos);

    let node = { type: 'call', name, args };
    if (power !== null) node = { type: 'bin', op: '^', left: node, right: power < 0 ? { type: 'neg', arg: { type: 'num', value: -power } } : { type: 'num', value: power } };
    return node;
  }

  parseAll() {
    if (this.peek().t === 'eof') throw new MathError('Empty input. Bold minimalism.');
    const ast = this.parseExpr(0);
    const tok = this.peek();
    if (tok.t !== 'eof') {
      if (this.is(tok, ')') || this.is(tok, '⌋') || this.is(tok, '⌉')) throw new MathError(UNBALANCED, tok.pos);
      if (this.is(tok, ',')) throw new MathError('Stray comma. Points need parentheses: (1, 2).', tok.pos);
      if (this.is(tok, '=')) throw new MathError("One '=' is plenty.", tok.pos);
      if (this.is(tok, '|')) throw new MathError('A stray |. Absolute values come in pairs.', tok.pos);
      throw new MathError(`Unexpected '${tok.v ?? tok.word}'.`, tok.pos);
    }
    return ast;
  }
}

function parseAst(src, knownVars = ['x', 'y', 't']) {
  if (typeof src !== 'string') throw new MathError('Expected some text. Got… not text.');
  if (src.length > MAX_LEN) throw new MathError(`That's a lot of math. Keep it under ${MAX_LEN} characters.`);
  const toks = tokenize(src);
  try {
    return new Parser(toks).parseAll();
  } catch (err) {
    // "rm -rf /" is a syntax error, but the real problem is that 'rm' isn't math.
    const word = toks.find((t) => t.kind === 'var' && t.word.length > 1 && !knownVars.includes(t.name));
    if (err instanceof MathError && word) throw wordError(word);
    throw err;
  }
}

function wordError(n) {
  if (n.wordCall) return new MathError(`Unknown function '${n.word}'. I know sin, cos, sqrt, ln and friends.`, n.pos);
  return new MathError(`I don't know '${n.word}'. I speak math, not English — try 'help'.`, n.pos);
}

// ───────────────────────────── analysis ─────────────────────────────

function walk(node, fn) {
  fn(node);
  if (node.left) walk(node.left, fn);
  if (node.right) walk(node.right, fn);
  if (node.arg) walk(node.arg, fn);
  if (node.args) for (const a of node.args) walk(a, fn);
  if (node.items) for (const a of node.items) walk(a, fn);
}

function varNodes(ast) {
  const out = [];
  walk(ast, (n) => { if (n.type === 'var') out.push(n); });
  return out;
}

const usedVarSet = (ast) => new Set(varNodes(ast).map((n) => n.name));

function listWords(arr) {
  if (arr.length === 0) return 'nothing';
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
}

// Throws a friendly MathError for the first variable not in `allowed`.
// hints: { y?: string, z?: string } override messages for those letters.
function checkVars(ast, allowed, hints = {}) {
  for (const n of varNodes(ast)) {
    if (allowed.includes(n.name)) continue;
    if (n.word.length > 1) throw wordError(n);
    if (n.callLike) throw new MathError(`Unknown function '${n.name}'. I know sin, cos, sqrt, ln and friends.`, n.pos);
    if (hints[n.name]) throw new MathError(hints[n.name], n.pos);
    if (allowed.includes(n.name.toLowerCase())) {
      throw new MathError(`Unknown variable '${n.name}' — did you mean '${n.name.toLowerCase()}'? I'm case-sensitive. Like a cat.`, n.pos);
    }
    if (n.name === 'z' && !allowed.includes('z')) throw new MathError('z is the output, not the input. Try z = …', n.pos);
    if (allowed.length === 0) throw new MathError(`Unknown variable '${n.name}' — this needs to be a plain number.`, n.pos);
    throw new MathError(`Unknown variable '${n.name}' — I only know ${listWords(allowed)}.`, n.pos);
  }
}
function rejectInnerTuples(ast) {
  walk(ast, (n) => {
    if (n.type === 'tuple' && n !== ast) throw new MathError("Points can't be part of a formula. (Yet.)", n.pos);
  });
}

function rejectTuple(ast, what) {
  if (ast.type === 'tuple') throw new MathError(what, ast.pos);
  rejectInnerTuples(ast);
}

function hasVars(node) {
  let found = false;
  walk(node, (n) => { if (n.type === 'var') found = true; });
  return found;
}

function isLiteralOnly(node) {
  let ok = true;
  walk(node, (n) => { if (n.type === 'const' || n.type === 'call' || n.type === 'fact') ok = false; });
  return ok;
}

// ───────────────────────────── compiler (AST → closures) ─────────────────────────────

const NO_SLOTS = [];

function compileNode(node, varNames) {
  const fn = compileRaw(node, varNames);
  // constant folding: any var-free subtree is evaluated once
  if (node.type !== 'num' && node.type !== 'var' && !hasVars(node)) {
    const v = fn(NO_SLOTS);
    return () => v;
  }
  return fn;
}

function compileRaw(node, varNames) {
  switch (node.type) {
    case 'num': { const v = node.value; return () => v; }
    case 'const': { const v = CONSTS[node.name].value; return () => v; }
    case 'var': {
      const idx = varNames.indexOf(node.name);
      if (idx < 0) throw new MathError(`Unknown variable '${node.name}'.`);
      return (s) => s[idx];
    }
    case 'neg': { const a = compileNode(node.arg, varNames); return (s) => -a(s); }
    case 'fact': { const a = compileNode(node.arg, varNames); return (s) => factorial(a(s)); }
    case 'bin': {
      const a = compileNode(node.left, varNames);
      const b = compileNode(node.right, varNames);
      switch (node.op) {
        case '+': return (s) => a(s) + b(s);
        case '-': return (s) => a(s) - b(s);
        case '*': return (s) => a(s) * b(s);
        case '/': return (s) => a(s) / b(s);
        case '^': {
          if (node.right.type === 'num' && node.right.value === 2) return (s) => { const v = a(s); return v * v; };
          return (s) => pow(a(s), b(s));
        }
      }
      break;
    }
    case 'call': {
      const spec = FUNCS[node.name];
      const args = node.args.map((x) => compileNode(x, varNames));
      if (args.length === 1) { const f = spec.fn; const a = args[0]; return (s) => f(a(s)); }
      if (args.length === 2) {
        const f = spec.fn2 ?? spec.fn;
        const [a, b] = args;
        return (s) => f(a(s), b(s));
      }
      const f = spec.fn;
      const vals = new Array(args.length);
      return (s) => {
        for (let k = 0; k < args.length; k++) vals[k] = args[k](s);
        return f(...vals);
      };
    }
    case 'tuple':
      throw new MathError("Points can't be part of a formula. (Yet.)");
  }
  throw new MathError('Something went sideways inside the parser. Not your fault. Probably.');
}

// ───────────────────────────── pretty printer (GeoGebra-ish) ─────────────────────────────

function supNumber(v) {
  const s = String(v);
  if (!/^\d+$/.test(s)) return null;
  return [...s].map((c) => SUP_OUT[c]).join('');
}

function prec(node) {
  switch (node.type) {
    case 'bin': return node.op === '+' || node.op === '-' ? 1 : node.op === '^' ? 3 : 2;
    case 'neg': return 2.5;
    case 'fact': return 4;
    case 'num': return prettyNumber(node.value).includes('×') ? 2 : 5;
    default: return 5;
  }
}

const wrap = (s) => `(${s})`;

function superscriptOf(node) {
  if (node.type === 'num' && Number.isInteger(node.value) && node.value < 1e6) return supNumber(node.value);
  if (node.type === 'neg' && node.arg.type === 'num' && Number.isInteger(node.arg.value) && node.arg.value < 1e6) {
    return SUP_OUT['-'] + supNumber(node.arg.value);
  }
  if (node.type === 'var' && SUP_OUT[node.name]) return SUP_OUT[node.name];
  if (node.type === 'neg' && node.arg.type === 'var' && SUP_OUT[node.arg.name]) return SUP_OUT['-'] + SUP_OUT[node.arg.name];
  return null;
}

function show(node) {
  switch (node.type) {
    case 'num': return prettyNumber(node.value);
    case 'var': return node.name;
    case 'const': return CONSTS[node.name].show;
    case 'neg': {
      const s = show(node.arg);
      return '−' + (prec(node.arg) <= 2.5 ? wrap(s) : s);
    }
    case 'fact': {
      const s = show(node.arg);
      return (prec(node.arg) < 5 ? wrap(s) : s) + '!';
    }
    case 'tuple': return wrap(node.items.map(show).join(', '));
    case 'call': {
      const spec = FUNCS[node.name];
      const inner = node.args.map(show).join(', ');
      switch (node.name) {
        case 'sqrt': case 'cbrt': {
          const a = node.args[0];
          const atomic = a.type === 'num' && prec(a) === 5 || a.type === 'var' || a.type === 'const';
          return spec.show + (atomic ? inner : wrap(inner));
        }
        case 'abs': return `|${inner}|`;
        case 'floor': return `⌊${inner}⌋`;
        case 'ceil': return `⌈${inner}⌉`;
        default: return spec.show + wrap(inner);
      }
    }
    case 'bin': {
      const { op, left, right } = node;
      if (op === '+' || op === '-') {
        const r = show(right);
        const rr = prec(right) <= 1 || right.type === 'neg' ? wrap(r) : r;
        return `${show(left)} ${op === '-' ? '−' : '+'} ${rr}`;
      }
      if (op === '*' || op === '/') {
        const l = show(left);
        const r = show(right);
        const ll = prec(left) < 2 ? wrap(l) : l;
        const rr = prec(right) <= 2.5 ? wrap(r) : r;
        return op === '*' ? `${ll}·${rr}` : `${ll} / ${rr}`;
      }
      // power
      const b = show(left);
      const bb = prec(left) <= 4 ? wrap(b) : b;
      const sup = superscriptOf(right);
      if (sup) return bb + sup;
      const e = show(right);
      return `${bb}^${prec(right) === 5 ? e : wrap(e)}`;
    }
  }
  return '?';
}

// ───────────────────────────── numbers ─────────────────────────────

const toSup = (s) => [...s].map((c) => SUP_OUT[c] ?? c).join('');

/** Human-friendly number: 0.30000000000000004 → "0.3", 1e21 → "1×10²¹", NaN → "undefined". */
export function prettyNumber(n, digits = 12) {
  if (typeof n !== 'number') n = Number(n);
  if (Number.isNaN(n)) return 'undefined';
  if (n === Infinity) return '∞';
  if (n === -Infinity) return '−∞';
  if (n === 0) return '0';
  const neg = n < 0;
  const a = Math.abs(n);
  let out;
  if (a >= 1e21 || a < 1e-6) {
    const [m, e] = a.toExponential(digits - 1).split('e');
    let mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
    let exp = Number(e);
    if (mant === '10') { mant = '1'; exp += 1; }
    out = `${mant}×10${toSup(String(exp))}`;
  } else if (Number.isInteger(a) && a < 1e15) {
    out = String(a);
  } else {
    const r = Number(a.toPrecision(digits));
    out = r >= 1e21 || r < 1e-6 ? prettyNumber(r, digits) : String(r);
  }
  return neg ? '−' + out : out;
}

// ───────────────────────────── names ─────────────────────────────

const POOLS = {
  fn: ['f', 'g', 'h', 'p', 'q', 'r', 's', 'u', 'v', 'w'],
  point: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  value: ['a', 'b', 'c', 'd', 'j', 'k', 'l', 'm', 'n'],
};
const SUB = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
const subscript = (k) => [...String(k)].map((c) => SUB[c]).join('');

const usedNames = new Set();

/** Forget every auto-assigned and user-given name. */
export function resetNames() { usedNames.clear(); }
/** Mark a name as taken (e.g. default objects created by hand). */
export function reserveName(name) { usedNames.add(String(name)); }
/** Free a name again (e.g. after the user deletes the object). */
export function releaseName(name) { usedNames.delete(String(name)); }

// With opts.taken the caller is the source of truth (deleted names become free again);
// without it, the module registry remembers every name handed out until resetNames().
function takenChecker(taken) {
  if (!taken) return (n) => usedNames.has(n);
  if (typeof taken === 'function') return taken;
  if (taken instanceof Set || taken instanceof Map) return (n) => taken.has(n);
  if (Array.isArray(taken)) return (n) => taken.includes(n);
  if (typeof taken === 'object') return (n) => Object.prototype.hasOwnProperty.call(taken, n);
  return () => false;
}

function autoName(pool, isTaken) {
  const base = POOLS[pool];
  for (let k = 0; ; k++) {
    for (const b of base) {
      const name = k === 0 ? b : b + subscript(k);
      if (!isTaken(name)) return name;
    }
  }
}

// ───────────────────────────── public API ─────────────────────────────

/**
 * Lower-level: compile an expression to (scope) => number.
 * Unknown variables (not in allowedVars) throw a MathError. Domain errors evaluate to NaN.
 */
export function compile(exprSrc, allowedVars = ['x', 't']) {
  const ast = parseAst(exprSrc, allowedVars);
  rejectTuple(ast, 'compile() wants a number, not a point.');
  checkVars(ast, allowedVars);
  const names = [...allowedVars];
  const ev = compileNode(ast, names);
  const slots = new Array(names.length).fill(NaN);
  return (scope) => {
    for (let k = 0; k < names.length; k++) {
      const v = scope?.[names[k]];
      slots[k] = v === undefined ? NaN : Number(v);
    }
    return ev(slots);
  };
}

const IMPLICIT_MSG = 'Implicit equations are above my pay grade. Try y = … (or ask GeoGebra).';
const Y_BOTH_SIDES = "y on both sides? That's an implicit curve — GeoGebra's job, not mine. Try y = …";
const NAME_RE = /^(\p{L}[\p{L}0-9_₀-₉]*)\s*(?:\(([^()]*)\))?$/u;

function reservedNameError(name) {
  if (name in CONST_SYMBOLS) return new MathError(`${name} is a constant. It's right there in the name.`);
  if (name === 'Γ') return new MathError("'Γ' is already a function. It got there first.");
  const low = name.toLowerCase();
  if (name === 'e' || (low.length > 1 && WORDS.get(low)?.kind === 'const')) {
    const c = CONSTS[name === 'e' ? 'e' : WORDS.get(low).name];
    return new MathError(`${c.show} is a constant. It's right there in the name.`);
  }
  if (low.length > 1 && WORDS.get(low)?.kind === 'func') {
    return new MathError(`'${name}' is already a function. It got there first.`);
  }
  return null;
}

function makeFn2d(ast, param, name, label, extra) {
  const names = param === 't' ? ['t'] : [param, 't'];
  checkVars(ast, names, extra.hints);
  const ev = compileNode(ast, names);
  const slots = [0, 0];
  const usesT = param !== 't' && usedVarSet(ast).has('t');
  const f = (x, t = 0) => { slots[0] = x; slots[1] = t; return ev(slots); };
  return { kind: 'fn2d', name, label, f, usesT };
}

function makeFn3d(ast, params, name, label, extra) {
  const names = params.includes('t') ? [...params] : [...params, 't'];
  checkVars(ast, names, extra.hints);
  const ev = compileNode(ast, names);
  const slots = [0, 0, 0];
  const usesT = !params.includes('t') && usedVarSet(ast).has('t');
  const f = (x, y, t = 0) => { slots[0] = x; slots[1] = y; slots[2] = t; return ev(slots); };
  return { kind: 'fn3d', name, label, f, usesT };
}

function makePoint(ast, name) {
  if (ast.items.length !== 2) {
    if (ast.items.length === 3) throw new MathError('3D points? Ambitious. Only (x, y) for now.', ast.pos);
    throw new MathError(`A point with ${ast.items.length} coordinates? This is a plane, not a hypercube.`, ast.pos);
  }
  rejectInnerTuples(ast);
  checkVars(ast, ['x', 'y', 't']);
  if (hasVars(ast)) throw new MathError('Points have to sit still — plain numbers only, no x, y or t inside.', ast.pos);
  const [x, y] = ast.items.map((it) => compileNode(it, [])(NO_SLOTS));
  if (Number.isNaN(x) || Number.isNaN(y)) throw new MathError('That point is undefined. Literally.', ast.pos);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new MathError('That point is at infinity. A bit too far to draw.', ast.pos);
  return { x, y };
}

function makeValue(ast) {
  let value = compileNode(ast, [])(NO_SLOTS);
  // sin(π) is 1.2e-16 in floating point; humans expect 0.
  if (value !== 0 && Math.abs(value) < 1e-14 && !isLiteralOnly(ast)) value = 0;
  return value;
}

/**
 * Parse a line from the Input bar into a plottable/evaluable object.
 * opts.taken: Set | Map | Array | object | (name) => boolean — names already in use by the caller.
 * When given, auto-naming consults only it (so names of deleted objects are reused); otherwise the
 * module registry (resetNames / reserveName / releaseName) is used.
 */
export function parseInput(src, opts = {}) {
  if (typeof src !== 'string') throw new MathError('Expected some text. Got… not text.');
  const text = src.trim().replace(/:=/g, '=');
  if (!text) throw new MathError('Empty input. Bold minimalism.');
  if (text.length > MAX_LEN) throw new MathError(`That's a lot of math. Keep it under ${MAX_LEN} characters.`);
  if (/==/.test(text)) throw new MathError("This isn't JavaScript. One '=' will do.");
  if (/[<>≤≥≠]|!=/.test(text)) throw new MathError('No inequalities here — everyone is equal on this plane.');

  const isTaken = takenChecker(opts.taken);
  const eqCount = (text.match(/=/g) || []).length;
  if (eqCount > 1) throw new MathError("One '=' is plenty.");

  let result;
  if (eqCount === 0) {
    result = fromBare(text, isTaken);
  } else {
    const at = text.indexOf('=');
    const lhs = text.slice(0, at).trim();
    const rhs = text.slice(at + 1).trim();
    if (!lhs) throw new MathError("Something has to go before the '='.");
    if (!rhs) throw new MathError("Nothing after the '='. Suspense!");
    result = fromEquation(lhs, rhs, isTaken);
  }
  usedNames.add(result.name);
  result.src = text;
  return result;
}

function fromBare(text, isTaken) {
  const ast = parseAst(text);
  if (ast.type === 'tuple') {
    const { x, y } = makePoint(ast, null);
    const name = autoName('point', isTaken);
    return { kind: 'point', name, label: `${name} = ${show(ast)}`, expr: show(ast), x, y };
  }
  rejectInnerTuples(ast);
  checkVars(ast, ['x', 'y', 't']);
  const vars = usedVarSet(ast);
  const expr = show(ast);
  if (vars.size === 0) {
    const value = makeValue(ast);
    const name = autoName('value', isTaken);
    return { kind: 'value', name, label: `${name} = ${prettyNumber(value)}`, expr, value };
  }
  const name = autoName('fn', isTaken);
  if (vars.has('y')) return { ...makeFn3d(ast, ['x', 'y'], name, `${name}(x, y) = ${expr}`, {}), expr };
  return { ...makeFn2d(ast, 'x', name, `${name}(x) = ${expr}`, {}), expr };
}

function fromEquation(lhs, rhs, isTaken) {
  const m = NAME_RE.exec(lhs);
  if (!m) {
    // still give parse errors on the left side priority if it's garbage
    parseAst(lhs);
    throw new MathError(IMPLICIT_MSG);
  }
  const name = m[1];
  const paramsRaw = m[2];
  const ast = parseAst(rhs, paramsRaw ? [...paramsRaw.split(',').map((p) => p.trim()), 't'] : ['x', 'y', 't']);
  const expr = show(ast);

  if (paramsRaw === undefined) {
    if (name === 'x') throw new MathError('x = … is a vertical line, not a function. Math is strict like that.');
    if (name === 't') throw new MathError("t is time. You can't set time. Believe me, I've tried.");
    if (name === 'y' || name === 'z') {
      rejectTuple(ast, `${name} = … wants a formula, not a point.`);
      const fname = autoName('fn', isTaken);
      if (name === 'y') {
        return { ...makeFn2d(ast, 'x', fname, `${fname}: y = ${expr}`, { hints: { y: Y_BOTH_SIDES } }), expr };
      }
      return { ...makeFn3d(ast, ['x', 'y'], fname, `${fname}: z = ${expr}`, { hints: { z: 'z on both sides? Bold. Implicit surfaces are a GeoGebra thing.' } }), expr };
    }
    const err = reservedNameError(name);
    if (err) throw err;
    if (ast.type === 'tuple') {
      const { x, y } = makePoint(ast, name);
      return { kind: 'point', name, label: `${name} = ${expr}`, expr, x, y };
    }
    rejectInnerTuples(ast);
    checkVars(ast, ['x', 'y', 't']);
    const vars = usedVarSet(ast);
    if (vars.size === 0) {
      const value = makeValue(ast);
      return { kind: 'value', name, label: `${name} = ${prettyNumber(value)}`, expr, value };
    }
    if (vars.has('y')) return { ...makeFn3d(ast, ['x', 'y'], name, `${name}(x, y) = ${expr}`, {}), expr };
    return { ...makeFn2d(ast, 'x', name, `${name}(x) = ${expr}`, {}), expr };
  }

  // f(x) = …, f(x, y) = …
  if (['x', 'y', 'z', 't'].includes(name)) throw new MathError(`'${name}' is a variable, not a name. Try f(x) = …`);
  const err = reservedNameError(name);
  if (err) throw err;
  const params = paramsRaw.split(',').map((p) => p.trim());
  if (params.length === 1 && params[0] === '') throw new MathError(`${name}() needs a variable. ${name}(x) is the classic.`);
  if (params.some((p) => !/^[A-Za-z]$/.test(p) || p === 'e')) {
    throw new MathError(`Parameters should be single letters, like ${name}(x) or ${name}(x, y).`);
  }
  if (params.length > 2) throw new MathError(`${params.length} variables? This is a plane, not a hypercube.`);
  if (params.length === 2 && params[0] === params[1]) throw new MathError(`${name}(${params[0]}, ${params[1]})? Pick two different letters.`);
  rejectTuple(ast, `${name}(${params.join(', ')}) wants a number, not a point.`);
  const head = `${name}(${params.join(', ')})`;
  if (params.length === 1) {
    const hints = {};
    if (params[0] === 'x') hints.y = `${head} has never heard of y. Try ${name}(x, y) = …`;
    return { ...makeFn2d(ast, params[0], name, `${head} = ${expr}`, { hints }), expr };
  }
  return { ...makeFn3d(ast, params, name, `${head} = ${expr}`, {}), expr };
}

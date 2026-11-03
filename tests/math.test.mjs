import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseInput, compile, MathError, resetNames, reserveName, releaseName, prettyNumber,
} from '../site/assets/js/math.js';

const SRC_PATH = fileURLToPath(new URL('../site/assets/js/math.js', import.meta.url));

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const ev = (src, x = 0, t = 0, y = 0) => compile(src, ['x', 'y', 't'])({ x, y, t });
const throwsMath = (fn, re) => assert.throws(fn, (e) => {
  assert.ok(e instanceof MathError, `expected MathError, got ${e?.constructor?.name}: ${e?.message}`);
  assert.equal(e.name, 'MathError');
  if (re) assert.match(e.message, re);
  return true;
});

beforeEach(() => resetNames());

describe('precedence & associativity', () => {
  test('basic arithmetic', () => {
    assert.equal(ev('1 + 2 * 3'), 7);
    assert.equal(ev('(1 + 2) * 3'), 9);
    assert.equal(ev('10 - 4 - 3'), 3);
    assert.equal(ev('100 / 10 / 5'), 2);
    assert.equal(ev('2 * 3 / 4'), 1.5);
  });
  test('power is right-associative and beats multiplication', () => {
    assert.equal(ev('2^3^2'), 512);
    assert.equal(ev('2 * 3^2'), 18);
    assert.equal(ev('2^3 * 2'), 16);
  });
  test('unary minus binds looser than power', () => {
    assert.equal(ev('-2^2'), -4);
    assert.equal(ev('(-2)^2'), 4);
    assert.equal(ev('-x^2', 3), -9);
    assert.equal(ev('2^-1'), 0.5);
    assert.equal(ev('2^-x^2', 1), 0.5);
    assert.equal(ev('--3'), 3);
    assert.equal(ev('2 - -3'), 5);
    assert.equal(ev('+3 + +4'), 7);
    assert.equal(ev('2*-3'), -6);
  });
  test('factorial is postfix and tight', () => {
    assert.equal(ev('5!'), 120);
    assert.equal(ev('0!'), 1);
    assert.equal(ev('-3!'), -6);
    assert.equal(ev('2^3!'), 64);
    assert.equal(ev('(1+2)!'), 6);
    close(ev('0.5!'), Math.sqrt(Math.PI) / 2);
    assert.ok(Number.isNaN(ev('(-1)!')));
  });
  test('numbers in all their forms', () => {
    assert.equal(ev('.5'), 0.5);
    assert.equal(ev('1.'), 1);
    assert.equal(ev('1e3'), 1000);
    assert.equal(ev('2.5E-2'), 0.025);
    assert.equal(ev('1e+2'), 100);
    assert.equal(ev('007'), 7);
  });
});

describe('implicit multiplication', () => {
  test('number · variable / constant / group', () => {
    assert.equal(ev('2x', 3), 6);
    close(ev('2pi'), 2 * Math.PI);
    close(ev('2π'), 2 * Math.PI);
    assert.equal(ev('2(x+1)', 3), 8);
    assert.equal(ev('3 4'), 12);
  });
  test('groups and variables', () => {
    assert.equal(ev('(x+1)(x-1)', 3), 8);
    assert.equal(ev('(x+1)x', 3), 12);
    assert.equal(ev('(x+1)2', 3), 8);
    assert.equal(ev('x(x+1)', 3), 12);
    assert.equal(ev('xy', 2, 0, 5), 10);
    assert.equal(ev('x y t', 2, 3, 5), 30);
    assert.equal(ev('2x^2', 3), 18);
    assert.equal(ev('x2', 3), 6);
  });
  test('next to functions', () => {
    close(ev('x sin(x)', 2), 2 * Math.sin(2));
    close(ev('xsin(x)', 2), 2 * Math.sin(2));
    close(ev('2sin(x)', 2), 2 * Math.sin(2));
    close(ev('sin(x)cos(x)', 2), Math.sin(2) * Math.cos(2));
    close(ev('sin(x)2', 2), 2 * Math.sin(2));
    close(ev('pi x', 2), 2 * Math.PI);
    close(ev('pix', 2), 2 * Math.PI);
    close(ev('ex', 2), 2 * Math.E);
    close(ev('2e^x', 1), 2 * Math.E);
  });
  test('same precedence as explicit * / (left to right)', () => {
    assert.equal(ev('1/2x', 4), 2);
    assert.equal(ev('6/2(1+2)'), 9); // the internet's favourite fight; we side with left-to-right
    assert.equal(ev('2^3x', 1), 8);
  });
  test('functions without parentheses', () => {
    close(ev('sin x', 1), Math.sin(1));
    close(ev('sin 2x', 1), Math.sin(2));
    close(ev('sin2x', 1), Math.sin(2));
    close(ev('sin x cos x', 1), Math.sin(1) * Math.cos(1));
    close(ev('sin x + 1', 1), Math.sin(1) + 1);
    close(ev('sin x / 2', 1), Math.sin(1) / 2);
    close(ev('sin x^2', 2), Math.sin(4));
    close(ev('sin -x', 1), Math.sin(-1));
    close(ev('ln x', 5), Math.log(5));
    close(ev('2 sin x', 1), 2 * Math.sin(1));
    close(ev('|sin x|', -1), Math.abs(Math.sin(-1)));
  });
  test('function powers and inverses', () => {
    close(ev('sin^2(x) + cos^2(x)', 0.7), 1);
    close(ev('sin²(x) + cos²(x)', 0.7), 1);
    close(ev('sin^2 x', 0.7), Math.sin(0.7) ** 2);
    close(ev('sin^-1(x)', 0.5), Math.asin(0.5));
    close(ev('tan^-1(1)'), Math.PI / 4);
    close(ev('ln^-1(x)', 2), 1 / Math.log(2)); // no inverse alias for ln: plain reciprocal
  });
});

describe('unicode & alternative operators', () => {
  test('× · ÷ − and **', () => {
    assert.equal(ev('2 × 3'), 6);
    assert.equal(ev('2·3'), 6);
    assert.equal(ev('2⋅3'), 6);
    assert.equal(ev('6 ÷ 4'), 1.5);
    assert.equal(ev('5 − 2'), 3);
    assert.equal(ev('5 – 2'), 3);
    assert.equal(ev('−x', 4), -4);
    assert.equal(ev('2**3'), 8);
    assert.equal(ev('2 ** 3 ** 2'), 512);
  });
  test('superscripts, roots and symbols', () => {
    assert.equal(ev('x²', 3), 9);
    assert.equal(ev('x³', 2), 8);
    assert.equal(ev('x¹⁰', 2), 1024);
    assert.equal(ev('x⁻¹', 4), 0.25);
    assert.equal(ev('x²y', 3, 0, 2), 18);
    assert.equal(ev('√4'), 2);
    assert.equal(ev('√(x+5)', 4), 3);
    close(ev('√2x', 3), Math.SQRT2 * 3);
    assert.equal(ev('∛27'), 3);
    close(ev('τ'), 2 * Math.PI);
    close(ev('φ'), (1 + Math.sqrt(5)) / 2);
    assert.equal(ev('∞'), Infinity);
  });
  test('floor/ceil brackets and Γ', () => {
    assert.equal(ev('⌊x⌋', 2.7), 2);
    assert.equal(ev('⌈x⌉', 2.2), 3);
    assert.equal(ev('2⌊x⌋', 2.7), 4);
    close(ev('Γ(5)'), 24);
    close(ev('log₂(8)'), 3);
    throwsMath(() => compile('⌊x'), /never got its ⌋/);
    throwsMath(() => compile('x⌋'), /Unbalanced/);
  });
  test('absolute value bars', () => {
    assert.equal(ev('|x|', -3), 3);
    assert.equal(ev('|x| - 1', -3), 2);
    assert.equal(ev('2|x|', -3), 6);
    assert.equal(ev('||x| - 5|', -3), 2);
    assert.equal(ev('|x - |x||', -3), 6);
  });
  test('case-insensitive multi-letter names', () => {
    close(ev('SIN(x)', 1), Math.sin(1));
    close(ev('Pi'), Math.PI);
    close(ev('Sqrt(2)'), Math.SQRT2);
  });
  test('non-breaking and odd whitespace is fine', () => {
    assert.equal(ev('2 +\t3\n'), 5);
  });
});

describe('functions', () => {
  test('the whole library', () => {
    close(ev('sin(1)'), Math.sin(1));
    close(ev('cos(1)'), Math.cos(1));
    close(ev('tan(1)'), Math.tan(1));
    close(ev('sec(1)'), 1 / Math.cos(1));
    close(ev('csc(1)'), 1 / Math.sin(1));
    close(ev('cot(1)'), 1 / Math.tan(1));
    close(ev('asin(0.5)'), Math.asin(0.5));
    close(ev('arcsin(0.5)'), Math.asin(0.5));
    close(ev('acos(0.5)'), Math.acos(0.5));
    close(ev('arccos(0.5)'), Math.acos(0.5));
    close(ev('atan(2)'), Math.atan(2));
    close(ev('arctan(2)'), Math.atan(2));
    close(ev('atan2(1, -1)'), Math.atan2(1, -1));
    close(ev('sinh(1)'), Math.sinh(1));
    close(ev('cosh(1)'), Math.cosh(1));
    close(ev('tanh(1)'), Math.tanh(1));
    close(ev('asinh(1)'), Math.asinh(1));
    close(ev('acosh(2)'), Math.acosh(2));
    close(ev('atanh(0.5)'), Math.atanh(0.5));
    close(ev('sqrt(2)'), Math.SQRT2);
    close(ev('cbrt(-8)'), -2);
    close(ev('nroot(-32, 5)'), -2);
    assert.equal(ev('abs(-2)'), 2);
    close(ev('exp(1)'), Math.E);
    close(ev('ln(e)'), 1);
    close(ev('log(1000)'), 3);
    close(ev('log10(1000)'), 3);
    close(ev('lg(100)'), 2);
    close(ev('log(2, 8)'), 3);
    close(ev('log2(8)'), 3);
    assert.equal(ev('floor(-1.5)'), -2);
    assert.equal(ev('ceil(1.2)'), 2);
    assert.equal(ev('round(2.5)'), 3);
    assert.equal(ev('sign(-3)'), -1);
    assert.equal(ev('sgn(4)'), 1);
    assert.equal(ev('min(3, 1, 2)'), 1);
    assert.equal(ev('max(3, 1, 2)'), 3);
    assert.equal(ev('max(7)'), 7);
    assert.equal(ev('mod(7, 3)'), 1);
    assert.equal(ev('mod(-1, 3)'), 2);
    close(ev('gamma(5)'), 24);
    close(ev('gamma(0.5)'), Math.sqrt(Math.PI));
  });
  test('constants', () => {
    close(ev('pi'), Math.PI);
    close(ev('e'), Math.E);
    close(ev('tau'), 2 * Math.PI);
    close(ev('phi'), (1 + Math.sqrt(5)) / 2);
    assert.equal(ev('infinity'), Infinity);
  });
  test('odd roots of negative numbers are real', () => {
    close(ev('x^(1/3)', -8), -2);
    close(ev('x^(2/3)', -8), 4);
    close(ev('(-32)^0.2'), -2);
    assert.ok(Number.isNaN(ev('x^0.5', -4)));
  });
});

describe('domain errors → NaN, never throw', () => {
  test('evaluation is total', () => {
    assert.ok(Number.isNaN(ev('sqrt(x)', -1)));
    assert.ok(Number.isNaN(ev('ln(x)', -1)));
    assert.equal(ev('ln(x)', 0), -Infinity);
    assert.equal(ev('1/x', 0), Infinity);
    assert.ok(Number.isNaN(ev('asin(2)')));
    assert.ok(Number.isNaN(ev('mod(1, 0)')));
    assert.ok(Number.isNaN(ev('0/0')));
    assert.ok(Number.isNaN(ev('gamma(-2)')));
    assert.equal(ev('171!'), Infinity);
  });
  test('missing scope vars are NaN', () => {
    const f = compile('x + t');
    assert.ok(Number.isNaN(f({ x: 1 })));
    assert.ok(Number.isNaN(f()));
    assert.equal(f({ x: 1, t: 2 }), 3);
    assert.equal(f({ x: '1', t: 2 }), 3);
  });
});

describe('compile()', () => {
  test('defaults to x and t', () => {
    const f = compile('x^2 + t');
    assert.equal(f({ x: 3, t: 1 }), 10);
    throwsMath(() => compile('x + y'), /Unknown variable 'y' — I only know x and t/);
  });
  test('custom variable lists', () => {
    assert.equal(compile('u*v', ['u', 'v'])({ u: 3, v: 4 }), 12);
    throwsMath(() => compile('x', []), /plain number/);
    assert.equal(compile('2+2', [])({}), 4);
  });
  test('is reusable and pure', () => {
    const f = compile('sin(x) + 1');
    const a = f({ x: 1 });
    f({ x: 2 });
    assert.equal(f({ x: 1 }), a);
  });
  test('rejects points', () => {
    throwsMath(() => compile('(1, 2)'), /not a point/);
  });
});

describe('parseInput — fn2d', () => {
  test('bare expression of x', () => {
    const o = parseInput('sin(x)');
    assert.equal(o.kind, 'fn2d');
    assert.equal(o.name, 'f');
    assert.equal(o.label, 'f(x) = sin(x)');
    close(o.f(1, 0), Math.sin(1));
    assert.equal(o.usesT, false);
    assert.equal(o.src, 'sin(x)');
  });
  test('y = …', () => {
    const o = parseInput('y = x^2');
    assert.equal(o.kind, 'fn2d');
    assert.equal(o.label, 'f: y = x²');
    assert.equal(o.f(3), 9);
    const c = parseInput('y=3');
    assert.equal(c.kind, 'fn2d');
    assert.equal(c.f(100), 3);
  });
  test('f(x) = …, named functions and := ', () => {
    const o = parseInput('f(x) = 2x+1');
    assert.equal(o.kind, 'fn2d');
    assert.equal(o.name, 'f');
    assert.equal(o.label, 'f(x) = 2·x + 1');
    assert.equal(o.f(2), 5);
    const g = parseInput('g(x)=x^3');
    assert.equal(g.name, 'g');
    assert.equal(parseInput('k(x) := x').name, 'k');
    assert.equal(parseInput('speed(x) = x').name, 'speed');
    assert.equal(parseInput('f_1(x) = x').name, 'f_1');
  });
  test('unicode names', () => {
    const th = parseInput('θ = 3');
    assert.equal(th.kind, 'value');
    assert.equal(th.label, 'θ = 3');
    assert.equal(parseInput('α(x) = x').label, 'α(x) = x');
    throwsMath(() => parseInput('π = 3'), /constant/);
    throwsMath(() => parseInput('Γ(x) = 3'), /already a function/);
  });
  test('name = expr-with-x is a function', () => {
    const o = parseInput('a = x^2');
    assert.equal(o.kind, 'fn2d');
    assert.equal(o.label, 'a(x) = x²');
  });
  test('other parameter letters', () => {
    const o = parseInput('f(u) = u^2 + t');
    assert.equal(o.label, 'f(u) = u² + t');
    assert.equal(o.f(3, 1), 10);
    assert.equal(o.usesT, true);
    const p = parseInput('p(t) = sin(t)');
    close(p.f(1, 99), Math.sin(1));
    assert.equal(p.usesT, false);
  });
  test('t animates', () => {
    const o = parseInput('sin(x + t)');
    assert.equal(o.usesT, true);
    close(o.f(1, 2), Math.sin(3));
    close(o.f(1), Math.sin(1)); // t defaults to 0
    const only = parseInput('t');
    assert.equal(only.kind, 'fn2d');
    assert.equal(only.f(5, 2), 2);
  });
  test('the default algebra objects print exactly like the spec', () => {
    assert.equal(parseInput('f(x) = 1.2 sin(x + t)').label, 'f(x) = 1.2·sin(x + t)');
    assert.equal(parseInput('g(x) = 0.04x^3 - 0.9x - 5').label, 'g(x) = 0.04·x³ − 0.9·x − 5');
  });
});

describe('parseInput — fn3d', () => {
  test('z = …', () => {
    const o = parseInput('z = sin(x)cos(y)');
    assert.equal(o.kind, 'fn3d');
    assert.equal(o.label, 'f: z = sin(x)·cos(y)');
    close(o.f(1, 2, 0), Math.sin(1) * Math.cos(2));
    assert.equal(o.usesT, false);
  });
  test('bare expression using y → 3D', () => {
    const o = parseInput('x*y');
    assert.equal(o.kind, 'fn3d');
    assert.equal(o.label, 'f(x, y) = x·y');
    assert.equal(o.f(2, 3), 6);
    assert.equal(parseInput('y').kind, 'fn3d');
    assert.equal(parseInput('sin(x)cos(y)').kind, 'fn3d');
  });
  test('y = … is NOT 3D even though y appears', () => {
    assert.equal(parseInput('y = sin(x)').kind, 'fn2d');
  });
  test('f(x, y) = … and t', () => {
    const o = parseInput('f(x, y) = sin(x + t) * y');
    assert.equal(o.kind, 'fn3d');
    assert.equal(o.label, 'f(x, y) = sin(x + t)·y');
    assert.equal(o.usesT, true);
    close(o.f(1, 2, 3), Math.sin(4) * 2);
    const z = parseInput('z = 2');
    assert.equal(z.kind, 'fn3d');
    assert.equal(z.f(1, 1), 2);
    const b = parseInput('b = x + y');
    assert.equal(b.kind, 'fn3d');
    assert.equal(b.label, 'b(x, y) = x + y');
    const uv = parseInput('h(u, v) = u - v');
    assert.equal(uv.f(5, 3), 2);
  });
});

describe('parseInput — points', () => {
  test('plain and named', () => {
    const a = parseInput('(1, 2)');
    assert.equal(a.kind, 'point');
    assert.deepEqual([a.name, a.x, a.y], ['A', 1, 2]);
    assert.equal(a.label, 'A = (1, 2)');
    const b = parseInput('A = (3,4)');
    assert.equal(b.name, 'A');
    const p = parseInput('P=(pi, -1)');
    assert.equal(p.name, 'P');
    close(p.x, Math.PI);
    assert.equal(p.y, -1);
    assert.equal(p.label, 'P = (π, −1)');
  });
  test('expressions inside', () => {
    const p = parseInput('(pi/2, sqrt(2))');
    close(p.x, Math.PI / 2);
    close(p.y, Math.SQRT2);
    assert.equal(p.label, 'A = (π / 2, √2)');
    const q = parseInput('(2^3, |−4|)');
    assert.deepEqual([q.x, q.y], [8, 4]);
  });
  test('auto names skip used ones', () => {
    parseInput('A = (0,0)');
    assert.equal(parseInput('(1,1)').name, 'B');
  });
  test('point errors', () => {
    throwsMath(() => parseInput('(1, 2, 3)'), /3D points/);
    throwsMath(() => parseInput('(1, 2, 3, 4)'), /hypercube/);
    throwsMath(() => parseInput('(x, 2)'), /sit still/);
    throwsMath(() => parseInput('(cos(t), sin(t))'), /sit still/);
    throwsMath(() => parseInput('(sqrt(-1), 0)'), /undefined/);
    throwsMath(() => parseInput('(1/0, 0)'), /infinity/);
    throwsMath(() => parseInput('(1,2) + 1'), /formula/);
    throwsMath(() => parseInput('2(1,2)'), /formula/);
    throwsMath(() => parseInput('f(x) = (1, 2)'), /not a point/);
    throwsMath(() => parseInput('y = (1, 2)'), /not a point/);
    throwsMath(() => parseInput('sin((1,2))'), /not points/);
    throwsMath(() => parseInput('(q, 2)'), /Unknown variable 'q'/);
  });
});

describe('parseInput — values', () => {
  test('arithmetic', () => {
    const o = parseInput('2+2');
    assert.equal(o.kind, 'value');
    assert.equal(o.name, 'a');
    assert.equal(o.value, 4);
    assert.equal(o.label, 'a = 4');
    assert.equal(o.expr, '2 + 2');
  });
  test('named', () => {
    const o = parseInput('a = 3^2');
    assert.equal(o.name, 'a');
    assert.equal(o.value, 9);
    assert.equal(o.label, 'a = 9');
    assert.equal(parseInput('2 * 2').name, 'b');
    assert.equal(parseInput('answer = 42').label, 'answer = 42');
  });
  test('irrational & tidy', () => {
    const o = parseInput('sqrt(2)');
    close(o.value, Math.SQRT2);
    assert.equal(o.label, 'a = 1.41421356237');
    assert.equal(parseInput('0.1 + 0.2').label, 'b = 0.3');
    assert.equal(parseInput('sin(pi)').value, 0);
    assert.equal(parseInput('1e-20').value, 1e-20); // explicit tiny numbers are kept
    assert.equal(parseInput('cos(pi)').label, 'j = −1'); // pool: a b c d j k …
  });
  test('undefined & infinite', () => {
    assert.equal(parseInput('sqrt(-1)').label, 'a = undefined');
    assert.equal(parseInput('1/0').label, 'b = ∞');
    assert.equal(parseInput('-1/0').label, 'c = −∞');
  });
  test('constants alone are values', () => {
    assert.equal(parseInput('pi').kind, 'value');
    assert.equal(parseInput('e').kind, 'value');
    assert.equal(parseInput('exp(1)').kind, 'value');
  });
});

describe('pretty labels', () => {
  const label = (s) => { resetNames(); return parseInput(s).label.replace(/^f\(x(, y)?\) = /, ''); };
  test('GeoGebra-ish output', () => {
    assert.equal(label('x^2'), 'x²');
    assert.equal(label('x^3'), 'x³');
    assert.equal(label('x^10'), 'x¹⁰');
    assert.equal(label('x^-1'), 'x⁻¹');
    assert.equal(label('x^0.5'), 'x^0.5');
    assert.equal(label('e^x'), 'eˣ');
    assert.equal(label('2^t'), '2ᵗ');
    assert.equal(label('e^(-x^2)'), 'e^(−x²)');
    assert.equal(label('e^-x'), 'e⁻ˣ');
    assert.equal(label('e⁻ˣ'), 'e⁻ˣ');
    assert.equal(label('2ˣ'), '2ˣ');
    assert.equal(label('(x+1)^2'), '(x + 1)²');
    assert.equal(label('(-x)^2'), '(−x)²');
    assert.equal(label('x^2^3'), 'x^(2³)');
    assert.equal(label('(x^2)^3'), '(x²)³');
    assert.equal(label('2x'), '2·x');
    assert.equal(label('2*x'), '2·x');
    assert.equal(label('2pi x'), '2·π·x');
    assert.equal(label('pi*x'), 'π·x');
    assert.equal(label('x/2'), 'x / 2');
    assert.equal(label('1/(x+1)'), '1 / (x + 1)');
    assert.equal(label('x/(2x)'), 'x / (2·x)');
    assert.equal(label('(x+1)/2'), '(x + 1) / 2');
    assert.equal(label('x - (x - 1)'), 'x − (x − 1)');
    assert.equal(label('x + -1'), 'x + (−1)');
    assert.equal(label('-x + 1'), '−x + 1');
    assert.equal(label('-(x+1)'), '−(x + 1)');
    assert.equal(label('-x^2'), '−x²');
    assert.equal(label('2*(-x)'), '2·(−x)');
    assert.equal(label('sqrt(x)'), '√x');
    assert.equal(label('sqrt(x+1)'), '√(x + 1)');
    assert.equal(label('cbrt(x)'), '∛x');
    assert.equal(label('abs(x)'), '|x|');
    assert.equal(label('|x - 1|'), '|x − 1|');
    assert.equal(label('floor(x)'), '⌊x⌋');
    assert.equal(label('ceil(x)'), '⌈x⌉');
    assert.equal(label('asin(x)'), 'sin⁻¹(x)');
    assert.equal(label('arctan(x)'), 'tan⁻¹(x)');
    assert.equal(label('log(2, x)'), 'log(2, x)');
    assert.equal(label('log2(x)'), 'log₂(x)');
    assert.equal(label('max(x, 1, 2)'), 'max(x, 1, 2)');
    assert.equal(label('x!'), 'x!');
    assert.equal(label('(x+1)!'), '(x + 1)!');
    assert.equal(label('sin^2(x)'), 'sin(x)²');
    assert.equal(label('sin x cos x'), 'sin(x)·cos(x)');
    assert.equal(label('tau x'), 'τ·x');
    assert.equal(label('.5x'), '0.5·x');
    assert.equal(label('1e3 x'), '1000·x');
    assert.equal(label('x y'), 'x·y');
    assert.equal(label('gamma(x)'), 'Γ(x)');
  });
  test('labels re-parse to the same function', () => {
    const inputs = ['x^2 - 3x + 2', 'sin(x)^2 / (x + 1)', '-x^3 + 2^x', '|x - 1| * sqrt(x)', 'e^(-x^2) * cos(3x)', 'asin(x/2) + floor(x)', 'x^(1/3)', '(x+1)!', 'log(2, x) - ln x'];
    for (const s of inputs) {
      resetNames();
      const a = parseInput(s);
      const b = parseInput(a.expr);
      for (const x of [-2.3, -0.5, 0.25, 1.7, 3.1]) {
        const va = a.f(x, 0);
        const vb = b.f(x, 0);
        if (Number.isNaN(va)) assert.ok(Number.isNaN(vb), `${s} @ ${x}`);
        else close(vb, va);
      }
    }
  });
});

describe('names', () => {
  test('function pool f, g, h, p, q, …', () => {
    const got = Array.from({ length: 11 }, () => parseInput('x').name);
    assert.deepEqual(got, ['f', 'g', 'h', 'p', 'q', 'r', 's', 'u', 'v', 'w', 'f₁']);
  });
  test('points and values have their own pools', () => {
    assert.equal(parseInput('(1,1)').name, 'A');
    assert.equal(parseInput('1').name, 'a');
    assert.equal(parseInput('x').name, 'f');
    assert.equal(parseInput('(2,2)').name, 'B');
    assert.equal(parseInput('2').name, 'b');
    assert.equal(parseInput('z = x').name, 'g');
  });
  test('explicit names are reserved for later auto-naming', () => {
    parseInput('f(x) = x');
    parseInput('g(x) = x');
    assert.equal(parseInput('x^2').name, 'h');
  });
  test('resetNames starts over', () => {
    parseInput('x');
    parseInput('x');
    resetNames();
    assert.equal(parseInput('x').name, 'f');
  });
  test('reserveName / releaseName', () => {
    reserveName('f');
    assert.equal(parseInput('x').name, 'g');
    releaseName('f');
    assert.equal(parseInput('x').name, 'f');
  });
  test('opts.taken is the source of truth when given (deleted names come back)', () => {
    const taken = new Map([['f', {}], ['g', {}]]);
    const h = parseInput('x', { taken });
    assert.equal(h.name, 'h');
    taken.set('h', h);
    assert.equal(parseInput('x', { taken }).name, 'p'); // pretend p was added, then deleted:
    assert.equal(parseInput('x', { taken }).name, 'p');
    taken.delete('f');
    assert.equal(parseInput('x^2', { taken }).name, 'f');
  });
  test('opts.taken (Set, Array, Map, function, object)', () => {
    assert.equal(parseInput('x', { taken: new Set(['f', 'g']) }).name, 'h');
    resetNames();
    assert.equal(parseInput('x', { taken: ['f'] }).name, 'g');
    resetNames();
    assert.equal(parseInput('x', { taken: new Map([['f', 1]]) }).name, 'g');
    resetNames();
    assert.equal(parseInput('x', { taken: (n) => n === 'f' }).name, 'g');
    resetNames();
    assert.equal(parseInput('(1,2)', { taken: { A: true } }).name, 'B');
  });
  test('failed parses do not consume names', () => {
    assert.throws(() => parseInput('sin('));
    assert.equal(parseInput('x').name, 'f');
  });
});

describe('errors are friendly MathErrors', () => {
  test('plain words', () => {
    throwsMath(() => parseInput('hello'), /'hello'.*math, not English/);
    throwsMath(() => parseInput('banana'), /'banana'/);
    throwsMath(() => parseInput('Hi there'), /Hi/);
    throwsMath(() => parseInput('ab'), /'ab'/);
    throwsMath(() => parseInput('foo(x)'), /Unknown function 'foo'/);
    throwsMath(() => parseInput('rm -rf /'), /'rm'.*not English/);
    throwsMath(() => parseInput('sudo make me a sandwich'), /'sudo'/);
    throwsMath(() => parseInput("f'(x)"), /Derivatives/);
    throwsMath(() => parseInput('f(2)'), /Unknown function 'f'/);
  });
  test('unknown variables', () => {
    throwsMath(() => parseInput('q'), /^Unknown variable 'q' — I only know x, y and t\.$/);
    throwsMath(() => parseInput('2a + 1'), /Unknown variable 'a'/);
    throwsMath(() => parseInput('X^2'), /case-sensitive/);
    throwsMath(() => parseInput('sin(θ)'), /Unknown variable 'θ'/);
    throwsMath(() => parseInput('z + 1'), /z is the output/);
    throwsMath(() => parseInput('f(x) = x + y'), /never heard of y.*f\(x, y\)/);
    throwsMath(() => parseInput('y = y + 1'), /both sides/);
    throwsMath(() => parseInput('z = z'), /both sides/);
  });
  test('structure', () => {
    throwsMath(() => parseInput(''), /Empty/);
    throwsMath(() => parseInput('   '), /Empty/);
    throwsMath(() => parseInput('(x+1'), /Unbalanced parentheses — happens to the best of us/);
    throwsMath(() => parseInput('x+1)'), /Unbalanced parentheses/);
    throwsMath(() => parseInput('((x)'), /Unbalanced/);
    throwsMath(() => parseInput(')('), /Unbalanced/);
    throwsMath(() => parseInput('()'), /Empty parentheses/);
    throwsMath(() => parseInput('|x'), /absolute/i);
    throwsMath(() => parseInput('x|'), /stray \|/i);
    throwsMath(() => parseInput('2+'), /Cliffhanger/);
    throwsMath(() => parseInput('2^'), /Cliffhanger/);
    throwsMath(() => parseInput('-'), /Cliffhanger/);
    throwsMath(() => parseInput('*2'), /at the start/);
    throwsMath(() => parseInput('2*/3'), /Unexpected '\/'/);
    throwsMath(() => parseInput('1, 2'), /Stray comma/);
    throwsMath(() => parseInput('1.2.3'), /too many dots/);
    throwsMath(() => parseInput('.'), /lonely/);
    throwsMath(() => parseInput('2 # 3'), /Unexpected '#'/);
    throwsMath(() => parseInput('x $'), /Unexpected '\$'/);
    throwsMath(() => parseInput('x⁻'), /superscript/);
  });
  test('functions misused', () => {
    throwsMath(() => parseInput('sin'), /sin of what/);
    throwsMath(() => parseInput('sin()'), /Empty parentheses/);
    throwsMath(() => parseInput('sin + 1'), /of what/);
    throwsMath(() => parseInput('sin(1, 2)'), /wants 1 argument, you gave 2\. Generous/);
    throwsMath(() => parseInput('mod(1)'), /wants 2 arguments/);
    throwsMath(() => parseInput('log(1, 2, 3)'), /1 or 2 arguments/);
    throwsMath(() => parseInput('√'), /of what/);
  });
  test('equations', () => {
    throwsMath(() => parseInput('x = 3'), /vertical line/);
    throwsMath(() => parseInput('t = 3'), /time/);
    throwsMath(() => parseInput('x^2 + y^2 = 1'), /Implicit/);
    throwsMath(() => parseInput('2x = 4'), /Implicit/);
    throwsMath(() => parseInput('y = '), /Suspense/);
    throwsMath(() => parseInput('= 3'), /before the '='/);
    throwsMath(() => parseInput('a = b = 3'), /One '=' is plenty/);
    throwsMath(() => parseInput('x == 2'), /JavaScript/);
    throwsMath(() => parseInput('y < x'), /inequalities/);
    throwsMath(() => parseInput('y ≥ x'), /inequalities/);
    throwsMath(() => parseInput('x != 2'), /inequalities/);
    throwsMath(() => parseInput('pi = 3'), /constant/);
    throwsMath(() => parseInput('e = 3'), /constant/);
    throwsMath(() => parseInput('sin(x) = x'), /already a function/);
    throwsMath(() => parseInput('sqrt = 2'), /already a function/);
    throwsMath(() => parseInput('y(x) = x'), /variable, not a name/);
    throwsMath(() => parseInput('f() = 3'), /needs a variable/);
    throwsMath(() => parseInput('f(x, y, z) = 3'), /hypercube/);
    throwsMath(() => parseInput('f(x, x) = 3'), /different letters/);
    throwsMath(() => parseInput('f(2) = 3'), /single letters/);
    throwsMath(() => parseInput('f(xy) = 3'), /single letters/);
  });
  test('limits', () => {
    throwsMath(() => parseInput('x+'.repeat(600) + 'x'), /a lot of math/);
    throwsMath(() => parseInput('('.repeat(150) + 'x' + ')'.repeat(150)), /nested/);
    throwsMath(() => parseInput(42), /text/);
  });
  test('every error is a MathError (fuzz)', () => {
    const alphabet = ['x', 'y', 't', '1', '2', '.', '+', '-', '*', '/', '^', '(', ')', ',', '|', '!', '=', ' ', 'sin', 'e', 'pi', '√', '²', 'q', 'f'];
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < 4000; k++) {
      let s = '';
      const len = 1 + Math.floor(rnd() * 12);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      resetNames();
      try {
        const o = parseInput(s);
        assert.ok(['fn2d', 'fn3d', 'point', 'value'].includes(o.kind), s);
        assert.equal(typeof o.label, 'string');
        if (o.f) {
          const v = o.kind === 'fn2d' ? o.f(0.7, 0.3) : o.f(0.7, -0.4, 0.3);
          assert.equal(typeof v, 'number', s);
        }
      } catch (e) {
        assert.ok(e instanceof MathError, `${JSON.stringify(s)} threw ${e?.name}: ${e?.message}`);
        assert.ok(e.message.length > 0 && e.message.length < 140, `message length for ${JSON.stringify(s)}`);
      }
    }
  });
});

describe('prettyNumber', () => {
  test('tidies floating point noise', () => {
    assert.equal(prettyNumber(0.30000000000000004), '0.3');
    assert.equal(prettyNumber(2.9999999999999996), '3');
    assert.equal(prettyNumber(1 / 3), '0.333333333333');
    assert.equal(prettyNumber(0.1), '0.1');
  });
  test('integers and signs', () => {
    assert.equal(prettyNumber(0), '0');
    assert.equal(prettyNumber(-0), '0');
    assert.equal(prettyNumber(42), '42');
    assert.equal(prettyNumber(-42), '−42');
    assert.equal(prettyNumber(123456789012345), '123456789012345');
    assert.equal(prettyNumber(-1.5), '−1.5');
  });
  test('scientific with superscripts', () => {
    assert.equal(prettyNumber(1e21), '1×10²¹');
    assert.equal(prettyNumber(1.5e21), '1.5×10²¹');
    assert.equal(prettyNumber(-2e30), '−2×10³⁰');
    assert.equal(prettyNumber(1e-7), '1×10⁻⁷');
    assert.equal(prettyNumber(1.25e-9), '1.25×10⁻⁹');
    assert.equal(prettyNumber(9.999999999999999e20), '1×10²¹');
    assert.equal(prettyNumber(0.000123), '0.000123');
  });
  test('specials', () => {
    assert.equal(prettyNumber(NaN), 'undefined');
    assert.equal(prettyNumber(Infinity), '∞');
    assert.equal(prettyNumber(-Infinity), '−∞');
    assert.equal(prettyNumber(Math.PI, 4), '3.142');
  });
});

describe('hygiene', () => {
  test('no eval, no Function constructor, no DOM', () => {
    const src = readFileSync(SRC_PATH, 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\beval\s*\(/);
    assert.doesNotMatch(src, /new\s+Function\b/);
    assert.doesNotMatch(src, /\bFunction\s*\(/);
    assert.doesNotMatch(src, /\b(document|window)\./);
    assert.doesNotMatch(src, /\bimport\s/);
  });
  test('functions are fast enough for 90×90 grids at 60fps', () => {
    const o = parseInput('z = sin(x)cos(y) + 0.3sin(2x + t)');
    const t0 = performance.now();
    let acc = 0;
    for (let f = 0; f < 30; f++) for (let i = 0; i < 90; i++) for (let j = 0; j < 90; j++) acc += o.f(i / 10, j / 10, f);
    const ms = (performance.now() - t0) / 30;
    assert.ok(Number.isFinite(acc));
    assert.ok(ms < 8, `one 90×90 frame took ${ms.toFixed(2)}ms`);
  });
});

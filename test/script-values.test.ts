// What a component script, or a module that makes an event, can give the page (src/script-values.ts).
import { describe, expect, test } from 'vitest';
import { parseModule } from '../src/compiler/index.js';
import { allowedValue, freshState, moduleConsts, type N } from '../src/script-values.js';

const ast = (code: string) => parseModule(code, 'x.ts') as unknown as N;
/** the value of `v` in `const v = …;`, at the end of `code` */
const value = (code: string) => { const a = ast(code); const d = (a.body as N[]).at(-1)!.declarations[0]; return allowedValue(d.init, moduleConsts(a)); };
const state = (body: string) => freshState(ast(`export class X extends Base { ${body} }`), (n) => String(n.start));

describe('allowedValue', () => {
  test.each([
    'const v = 1', 'const v = `a${x}`', 'const v = a + b > c', 'const v = !x', 'const v = x ? "wide" : "narrow"', 'const v = { n: 1, ok: !x, list: [1, "a"] }',
    'const v = structuredClone(this.props.item)', 'const v = JSON.parse(s)', 'const v = new Map()', 'const v = Number(x)', 'const v = Math.round(w)',
    'const w = 3; const v = { w }', 'const m = a < b ? "x" : "y"; const v = m',
  ])('accepted: %s', (code) => expect(value(code)).toBe(true));
  test.each([
    'const v = x', 'const v = this.props.item', 'const v = { item }', 'const v = [x]', 'const v = f(x)', 'const v = x.y', 'const v = new Foo()', 'const v = new Map([[1, x]])',
    'let w = 3; const v = w', 'const w = 1; function f(w) {} const v = w', 'const v = { ...x }', 'const v = { get a() { return 1; } }',
  ])('rejected: %s', (code) => expect(value(code)).toBe(false));
});

describe('freshState', () => {
  test.each([
    'up() { this.state.dragging = true; this.state.dragging = false; }',
    'm() { const stacked = a + b > c; if (stacked !== this.state.stacked) this.state.stacked = stacked; }',
    'm() { this.state.n++; this.state.n += 2; this.state.label = `${this.state.n} items`; }',
    'm() { this.state.copy = structuredClone(this.props.item); this.root.addEventListener("x", () => this.emit("y")); }',
  ])('accepted: %s', (body) => expect(state(body)).toBeNull());
  test.each([
    ['m() { this.state.held = this.props.item; }', /`this\.state\.held` given a value the build cannot follow/],
    ['m(x) { this.state.held = x; }', /`this\.state\.held` given a value/],
    ['m() { this.state.list.push(1); }', /`this\.state\.list` read where its value goes on/],
    ['m() { const s = this.state; }', /`this\.state` used as a value/],
    ['m() { helper(this); }', /`this` used as a value/],
    ['m(k) { this[k] = 1; }', /a member of `this` read by a computed key/],
    ['m() { this.state.n ??= this.props.item; }', /`this\.state\.n \?\?=`/],
    ['m() { return this.state.items; }', /read where its value goes on/],
  ])('rejected: %s', (body, why) => expect(state(body)).toMatch(why));
});

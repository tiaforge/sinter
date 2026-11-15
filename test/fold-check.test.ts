// What may fold (src/fold-check.ts): per exported function, through what it calls and imports, only
// ECMAScript's own globals; packages resolved with production conditions; cached per module.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { FoldCache, foldReason, foldVerdict, foldVerdicts, resolveImport } from '../src/fold-check.js';
import { readHelperManifest } from '../src/compiler/index.js';
import { readFileSync } from 'node:fs';

const root = mkdtempSync(join(tmpdir(), 'sinter-fold-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };

put('src/sinter.helpers.ts', `export * as fmt from './lib/fmt.ts';
export { slug, viaPkg, viaDom, viaEnv } from './lib/text.ts';
export { id } from './lib/top.ts';
export const upper = (s: string): string => s.toUpperCase();
export function stamp(): number { return Date.now(); }
export type Unused = string;
`);
put('src/lib/fmt.ts', `const digits = { short: 2 };
function round(n: number) { return Math.round(n * 100) / 100; }
export function price(n: number) { return round(n).toFixed(digits.short); }
export function local(d: Date) { return d.toLocaleString(); }
export function chance() { return Math.random(); }
export function shadow() { const location = { href: 'x' }; const fetch = (u: string) => u; return fetch(location.href); }
export function html(el: { innerHTML: string }) { el.innerHTML = '<b>'; }
export function mode() { return import.meta.env.MODE; }
export function later() { return import('./other.ts'); }
export function calls() { return remote(); }
function remote() { return fetch('/x'); }
export const arrow = (xs: number[]) => xs.map((x) => { let globalThis = x; return globalThis * 2; });
export function leaks() { return globalThis.x; }
export function classy() { class Box { v = 1; get() { return this.v; } } return new Box().get(); }
export function catches() { try { return JSON.parse('{'); } catch (window) { return String(window); } }
`);
put('src/lib/text.ts', `import { clean } from './clean.ts';
import plain, { twice } from 'fakelib';
import * as dom from 'domlib';
import { mode } from 'envlib';
export function slug(s: string) { return clean(s).toLowerCase().replace(/[^a-z]+/g, '-'); }
export function viaPkg(s: string) { return twice(plain(s)); }
export function viaDom(s: string) { return dom.render(s); }
export function viaEnv() { return mode(); }
`);
put('src/lib/clean.ts', 'export const clean = (s: string) => s.trim();\n');
put('src/lib/top.ts', 'const started = Date.now();\nexport const id = <T>(x: T): T => x;\nexport const since = () => started;\n');
// production conditions: `browser` is not one of them, `production` wins over `development`
put('node_modules/fakelib/package.json', JSON.stringify({ name: 'fakelib', type: 'module', exports: { '.': { browser: './dom.js', development: './dev.js', production: './plain.js', default: './dev.js' } } }));
put('node_modules/fakelib/plain.js', 'export default (s) => s;\nexport const twice = (s) => s + s;\n');
put('node_modules/fakelib/dom.js', 'export default (s) => { const e = document.createElement("i"); e.innerHTML = s; return e.textContent; };\nexport const twice = (s) => s + s;\n');
put('node_modules/fakelib/dev.js', 'export default (s) => { console.warn(s); return s; };\nexport const twice = (s) => s + s;\n');
put('node_modules/domlib/package.json', JSON.stringify({ name: 'domlib', type: 'module', main: 'index.js' }));
put('node_modules/domlib/index.js', 'export function render(s) { return document.title + s; }\nexport function pure(s) { return s; }\n');
put('node_modules/envlib/package.json', JSON.stringify({ name: 'envlib', type: 'module', module: 'esm.js', main: 'cjs.js' }));
put('node_modules/envlib/esm.js', 'export const mode = () => process.env.NODE_ENV;\n');

const manifest = () => readHelperManifest(readFileSync(join(root, 'src/sinter.helpers.ts'), 'utf8'), { module: '/src/sinter.helpers.ts', file: join(root, 'src/sinter.helpers.ts'), readFile: (f) => readFileSync(f, 'utf8') });
const verdicts = (cache = new FoldCache()) => foldVerdicts(manifest(), root, join(root, 'src/sinter.helpers.ts'), cache);
const why = (v: ReturnType<typeof foldVerdict> | undefined) => (v && !v.fold ? v.reason : 'folds');

describe('what may fold, per helper', () => {
  const v = verdicts();
  test('per function: one helper that reads the clock does not stop the others in the module', () => {
    expect(why(v.get('upper'))).toBe('folds');
    expect(why(v.get('stamp'))).toBe('`Date`');
    expect(why(v.get('fmt$price'))).toBe('folds');
  });

  test('the globals: an allowlist of ECMAScript\'s, without what reads the clock, the locale or chance, or writes markup', () => {
    expect(why(v.get('fmt$local'))).toBe('`.toLocaleString`');
    expect(why(v.get('fmt$chance'))).toBe('`Math.random`');
    expect(why(v.get('fmt$html'))).toBe('`.innerHTML`');
    expect(why(v.get('fmt$mode'))).toBe('`import.meta.env`');
    expect(why(v.get('fmt$later'))).toBe('`import()`');
    expect(why(v.get('fmt$leaks'))).toBe('`globalThis`');
    expect(why(v.get('fmt$classy'))).toBe('folds');
  });

  test('a local variable named like a global does not count', () => {
    expect(why(v.get('fmt$shadow'))).toBe('folds');
    expect(why(v.get('fmt$arrow'))).toBe('folds');
    expect(why(v.get('fmt$catches'))).toBe('folds');
  });

  test('through the functions it calls, with where and the chain', () => {
    const c = v.get('fmt$calls')!;
    expect(c.fold).toBe(false);
    if (c.fold) return;
    expect([c.reason, c.file.slice(root.length + 1), c.line, c.chain]).toEqual(['`fetch`', 'src/lib/fmt.ts', 11, ['calls', 'remote']]);
    expect(foldReason(c, root)).toBe('it reaches `fetch` (src/lib/fmt.ts:11:28, through calls → remote), which is not one of the globals a build-time call may use');
  });

  test('a module\'s top-level code counts for every function in it; imports across app modules', () => {
    expect(why(v.get('id'))).toBe('`Date`');
    expect(why(v.get('slug'))).toBe('folds');
  });

  test('into packages, with production conditions (not `browser`, `production` over `development`); `module` before `main`', () => {
    expect(resolveImport('fakelib', join(root, 'src/lib/text.ts'), root)).toBe(join(root, 'node_modules/fakelib/plain.js'));
    expect(why(v.get('viaPkg'))).toBe('folds');
    // a namespace import: only the member called counts, and it reads `document`
    expect(why(v.get('viaDom'))).toBe('`document`');
    expect(why(v.get('viaEnv'))).toBe('`process`');
  });
});

test('the cache: a module is analysed once while its file is unchanged, and again when it changes', () => {
  const cache = new FoldCache();
  verdicts(cache);
  const fmt = cache.modules.get(join(root, 'src/lib/fmt.ts'))!.info;
  verdicts(cache);
  expect(cache.modules.get(join(root, 'src/lib/fmt.ts'))!.info).toBe(fmt);
  put('src/lib/clean.ts', 'export const clean = (s: string) => s.trim() + Date.now();\n');
  const later = new Date(Date.now() + 5000);
  utimesSync(join(root, 'src/lib/clean.ts'), later, later);
  expect(why(verdicts(cache).get('slug'))).toBe('`Date`');
  expect(cache.modules.get(join(root, 'src/lib/fmt.ts'))!.info).toBe(fmt);
});

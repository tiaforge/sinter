// What a page's modules can send (src/event-senders.ts): every module from the entries through every import, each place
// that makes an event. Accepted: a literal name with no detail or a primitive one. Rejected: what the build cannot read
// or follow makes that name, or every name, untraceable.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { eventSenders } from '../src/event-senders.js';

const app = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'sn-ev-'));
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), text); }
  return root;
};
const scan = (files: Record<string, string>) => { const root = app(files); return eventSenders([join(root, 'src/main.ts')], root); };

test('accepted: literal names with no detail or a primitive one, through imports, a package and a component script\'s `this.emit`', () => {
  const r = scan({
    'src/main.ts': `import { step } from './lib/step.ts'; import { go } from 'pkg'; export const a = () => document.body.dispatchEvent(new CustomEvent('list-step', { detail: 1, bubbles: true }));
      export class X extends HTMLElement { up() { this.emit('width', this.clientWidth + 1); this.emit('ping'); this.dispatchEvent(new Event('change')); } }`,
    'src/lib/step.ts': 'export const step = (by: number) => new CustomEvent(`step`, { detail: by > 0 ? 1 : -1 }); export const k = () => new KeyboardEvent("keydown", { key: "j" });',
    'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': { browser: './b.js', default: './n.js' } } }),
    'node_modules/pkg/b.js': 'export const go = () => window.dispatchEvent(new Event("resize"));',
    'node_modules/pkg/n.js': 'import "node:fs"; export const go = () => 0;',
  });
  expect(r).toEqual({ unknown: null, risky: new Map() });
});

test('rejected, one name: a detail that is not surely a primitive (a variable, an object), in either build of a package', () => {
  const r = scan({
    'src/main.ts': `import 'pkg'; export const a = (o: object, n: number) => [new CustomEvent('pick', { detail: o }), new CustomEvent('box', { detail: { n } }), new CustomEvent('init', o)];
      export class X { up(m: string) { this.emit('media', m); } }`,
    'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': { browser: './b.js', default: './n.js' } } }),
    'node_modules/pkg/b.js': 'export const go = (x) => new CustomEvent("from-browser", { detail: x });',
    'node_modules/pkg/n.js': 'export const go = (x) => new CustomEvent("from-node", { detail: x });',
  });
  expect(r.unknown).toBeNull();
  expect([...r.risky.keys()].sort()).toEqual(['box', 'from-browser', 'from-node', 'init', 'media', 'pick']);
  expect(r.risky.get('pick')).toMatch(/^`pick` is made with a detail the build cannot follow \(src\/main\.ts:1:\d+\)$/);
});

test.each([
  ['a name that is no literal', 'export const a = (n: string) => new CustomEvent(n);', /a `new CustomEvent\(…\)` named by a value \(src\/main\.ts:1:\d+\)/],
  ['a class that extends an event\'s', 'export class E extends CustomEvent<number> {}', /a class that extends `CustomEvent`/],
  ['an event made the old way', 'export const a = () => document.createEvent("CustomEvent");', /`createEvent\(\)`/],
  ['an event class taken as a value', 'const E = CustomEvent; export const a = () => new E("x", { detail: {} });', /`CustomEvent` used as a value/],
  ['a detail assigned', 'export const a = (o: object) => { const e: any = new Event("x"); e.detail = o; return e; };', /a `detail` assigned/],
  ['a detail set by `Object.assign()`', 'export const a = (o: object) => Object.assign(new Event("x"), { detail: o });', /a `detail` set by `Object\.assign\(\)`/],
  ['a module it cannot find', 'import "missing-package"; export {};', /`missing-package`, imported by `src\/main\.ts`, could not be found/],
  ['a module named by a value', 'export const a = (m: string) => import(m);', /an `import\(\)` of a module named by a value/],
])('rejected, every name: %s', (_, text, why) => {
  expect(scan({ 'src/main.ts': text }).unknown).toMatch(why);
});

test('a page\'s inline scripts by their text; a module of another origin cannot be read', () => {
  const root = app({ 'src/main.ts': 'export {};' });
  expect(eventSenders([join(root, 'src/main.ts')], root, [{ name: join(root, 'index.html#script'), text: 'document.dispatchEvent(new CustomEvent("x", { detail: window }))' }]).risky.has('x')).toBe(true);
  expect(eventSenders(['https://cdn.example/lib.js'], root).unknown).toMatch(/could not be read/);
});

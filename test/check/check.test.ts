import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { compile, readHelperManifest } from '../../src/compiler/index.js';
import { check, findTsc, typeExports } from '../../src/check/index.js';

const tsc = findTsc(process.cwd());

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-check-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const TYPES = `export interface Contact { id: number; name: string; emails: string[] }
export type Page<T> = { items: T[]; total: number };
`;
const HELPERS = `export * as m from './messages.js';
/** @param {number} n */
export function twice(n) { return n * 2; }
`;
const MESSAGES = `/** @param {{count: number}} p */
export const items_count = (p) => \`\${p.count} items\`;
`;
const helpers = { module: '/src/sinter.helpers.js', names: ['twice'], namespaces: { m: { module: '/src/messages.js', members: ['items_count'] } } };

function run(html: string, extra: Record<string, string> = {}) {
  const root = project({ 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.js': HELPERS, 'src/messages.js': MESSAGES, ...extra });
  const file = join(root, 'index.html');
  writeFileSync(file, html);
  const out = compile(html, { file, root, dev: false, helpers, readFile: (p) => readFileSync(p, 'utf8'), check: true });
  const result = check({ root, units: [out.check!], helpers, types: join(root, 'src/sinter.types.ts'), tsc });
  return { root, compile: out.diagnostics, ...result, text: readFileSync(join(root, '.sinter/check/index.html.js'), 'utf8') };
}

const page = (body: string) => `<!doctype html><html><head></head><body>
<sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" type="Contact[]"></sn-resource>
${body}
</body></html>`;

/** 1-based line and column of `needle` (the `nth` occurrence) in `text`. */
function at(text: string, needle: string, nth = 1): [number, number] {
  let i = -1;
  for (let n = 0; n < nth; n++) i = text.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`not found: ${needle}`);
  const before = text.slice(0, i).split('\n');
  return [before.length, before[before.length - 1]!.length + 1];
}

function one(html: string, message: RegExp, needle: string, extra?: Record<string, string>) {
  const r = run(html, extra);
  expect(r.diagnostics.map((d) => d.message)).toHaveLength(1);
  const d = r.diagnostics[0]!;
  expect(d.code).toBe('SN208');
  expect(d.message).toMatch(message);
  expect([d.line, d.col]).toEqual(at(html, needle));
  return d;
}

describe('sinter check', () => {
  test('a typo on a typed resource item, at its HTML position', () => {
    one(page('<ul><template data-sn-for="c in contacts"><li data-sn-text="c.nmae"></li></template></ul>'),
      /Property 'nmae' does not exist on type 'Contact'. \(TS2339\)/, 'nmae');
  });

  test('state typed by a JSDoc cast; a handler assigns a wrong value', () => {
    one(page(`<div data-sn-state="{ editing: /** @type {Contact|null} */ (null) }">
  <button data-sn-on-click="editing = contacts[0]">ok</button>
  <button data-sn-on-click="editing = 5">wrong</button>
</div>`), /Type 'number' is not assignable to type 'Contact'/, 'editing = 5');
  });

  test('$event and $el have the DOM types of the event and element', () => {
    one(page(`<div data-sn-state="{ q: '' }">
  <input data-sn-on-input="q = $el.value">
  <button data-sn-on-click="q = $event.button">x</button>
</div>`), /Type 'number' is not assignable to type 'string'/, 'q = $event');
    one(page(`<div data-sn-state="{ q: '' }"><input data-sn-on-input="q = $el.valu"></div>`), /Did you mean 'value'\?/, 'valu');
  });

  test('helpers and namespace members are checked against their JSDoc signatures', () => {
    one(page(`<p data-sn-text="twice('2')"></p>`), /'string' is not assignable to parameter of type 'number'/, "'2'");
    one(page(`<p data-sn-text="m.items_count({ count: 'x' })"></p>`), /Type 'string' is not assignable to type 'number'/, 'count:');
  });

  test('a wrong type name is reported on the `type` attribute', () => {
    const html = page('<p data-sn-text="contacts.length"></p>').replace('type="Contact[]"', 'type="Contct[]"');
    one(html, /Cannot find name 'Contct'/, 'Contct[]');
  });

  test('a multi-line expression maps lines and columns', () => {
    one(page(`<ul><template data-sn-for="c in contacts.filter((c) =>
      c.name.startsWith('a') &&
      c.emails.lenght > 0)"><li></li></template></ul>`), /Property 'lenght' does not exist/, 'lenght');
  });

  test('loop index, state inside a row and store functions', () => {
    const html = page(`<ul><template data-sn-for="(c, i) in contacts"><li data-sn-state="{ first: i == 0 }">
  <b data-sn-text="first.toFixed()"></b>
  <button data-sn-on-click="patch('contacts', c, { name: 'x' })">ok</button>
  <button data-sn-on-click="patch('contacts', c, { nme: 'x' })">typo</button>
</li></template></ul>`);
    const r = run(html);
    expect(r.diagnostics.map((d) => [d.message.match(/TS\d+/)![0], d.line, d.col])).toEqual([
      ['TS2339', ...at(html, 'toFixed')],
      ['TS2561', ...at(html, 'nme')],
    ]);
  });

  test('$error in catch and $result in then', () => {
    one(page(`<div data-sn-state="{ status: 0, saved: null }">
  <button data-sn-post="/api/x" data-sn-then="saved = $result.anything" data-sn-catch="status = $error.statsu">go</button>
</div>`), /Property 'statsu' does not exist on type 'Err'/, 'statsu');
  });

  test('a partial maps to its own file, with the include chain', () => {
    const row = '<li>\n  <b data-sn-text="c.emial"></b></li>';
    const r = run(page('<ul><template data-sn-for="c in contacts"><sn-include src="./row.html"></sn-include></template></ul>'), { 'row.html': row });
    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0]!;
    expect(d.file).toBe(join(r.root, 'row.html'));
    expect([d.line, d.col]).toEqual(at(row, 'emial'));
    expect(d.message).toMatch(/Property 'emial' does not exist on type 'Contact'. \(TS2339\) \(included from index.html:3\)$/);
  });

  test('untyped resources: SN504 per resource, `type="any"` opts out, coverage counts both', () => {
    const r = run(page(`<sn-resource name="tags" src="/api/tags"></sn-resource>
<sn-resource name="raw" src="/api/raw" type="any"></sn-resource>
<p data-sn-text="tags.whatever + raw.anything + contacts.length"></p>`));
    expect(r.compile.filter((d) => d.code === 'SN504').map((d) => d.message)).toEqual(['resource `tags` has no type: expressions using it are not checked']);
    expect(r.diagnostics).toEqual([]);
    expect([r.typed, r.resources]).toEqual([2, 3]);
  });

  test('names the types module exports', () => {
    expect(typeExports(`export interface A {}
export declare type B<T> = T;
export class C {}
export { D, type E, F as G };
/** @typedef {{a: 1}} H */`)).toEqual(['A', 'B', 'C', 'D', 'E', 'G', 'H']);
  });

  test('the RealWorld example, untyped, has no type errors (no false positives)', () => {
    const root = join(import.meta.dirname, '../../examples/realworld');
    const hf = join(root, 'src/sinter.helpers.js');
    const read = (p: string) => readFileSync(p, 'utf8');
    const rw = readHelperManifest(read(hf), { module: '/src/sinter.helpers.js', file: hf, readFile: read });
    const units = readdirSync(root).filter((f) => f.endsWith('.html')).map((f) =>
      compile(read(join(root, f)), { file: join(root, f), root, dev: false, helpers: rw, readFile: read, check: true }).check!);
    const outDir = mkdtempSync(join(tmpdir(), 'sinter-check-rw-'));
    const r = check({ root, units, helpers: rw, types: null, tsc, outDir });
    expect(r.diagnostics).toEqual([]);
    expect(units.reduce((n, u) => n + u.exprs.length, 0)).toBeGreaterThan(300);
  });
});

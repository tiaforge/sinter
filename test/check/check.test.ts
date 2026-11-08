import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { compile, readHelperManifest } from '../../src/compiler/index.js';
import { check, checkPage, findTsc, typeExports } from '../../src/check/index.js';
import { schemaToTs, specDeclarations } from '../../src/check/openapi-types.js';
import { project as projectOf } from '../../src/project.js';

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

  test('data-sn-attr values are checked against SinterAttributes, which a library or the types module extends', () => {
    const typed = `${TYPES}declare global { interface SinterAttributes { 'data-tone'?: 'danger' | 'success' | null | false } }\n`;
    const html = page(`<p data-sn-attr="{'data-tone': contacts.length ? 'danger' : 'sucess', title: 'x'}"></p>`);
    one(html, /Type '"sucess"' is not assignable to type '"danger" \| "success"/, "'data-tone'", { 'src/sinter.types.ts': typed });
    // other keys and untyped projects are unaffected
    expect(run(page(`<p data-sn-attr="{'data-tone': contacts.length ? 'danger' : null, href: 1}"></p>`), { 'src/sinter.types.ts': typed }).diagnostics).toEqual([]);
    expect(run(html).diagnostics).toEqual([]);
  });

  test('helpers and namespace members are checked against their JSDoc signatures', () => {
    one(page(`<p data-sn-text="twice('2')"></p>`), /'string' is not assignable to parameter of type 'number'/, "'2'");
    one(page(`<p data-sn-text="m.items_count({ count: 'x' })"></p>`), /Type 'string' is not assignable to type 'number'/, 'count:');
  });

  test('sn-event: state around the sync is in scope; shadowing a typed payload field is an error', () => {
    const types = `${TYPES}export interface Refetch { mailbox: string; account_id: string }\n`;
    const sync = (when: string) => page(`<main data-sn-state="{ sel: 'inbox', account_id: 'a' }">
<sn-sync src="/api/events"><sn-event name="r" resource="contacts" op="refetch" type="Refetch" when="${when}"></sn-event></sn-sync>
<p data-sn-text="contacts.length + sel"></p></main>`);
    expect(run(sync('mailbox === sel'), { 'src/sinter.types.ts': types }).diagnostics).toEqual([]);
    expect(run(sync('mailbox === sel.lenght'), { 'src/sinter.types.ts': types }).diagnostics.map((d) => d.message))
      .toEqual([expect.stringMatching(/Property 'lenght' does not exist on type 'string'/)]);
    // `account_id` is state here, so it cannot also mean the payload field
    const d = run(sync('account_id === sel'), { 'src/sinter.types.ts': types }).diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toMatch(/state `account_id` shadows the payload field `account_id`: rename the state/);
  });

  test('sn-event `then`: the typed payload and the state are checked; SN506 without a type', () => {
    const files = { 'src/sinter.types.ts': `${TYPES}export interface Removed { id: number }\n` };
    const html = (then: string, type = ' type="Removed"') => page(`<main data-sn-state="{ sel: /** @type {Contact|null} */ (null), last: '' }">
<sn-sync src="/api/events"><sn-event name="r" resource="contacts" op="remove"${type} then="${then}"></sn-event></sn-sync>
<dialog id="detail"></dialog><p data-sn-text="contacts.length + (sel?.name ?? last)"></p></main>`);
    expect(checkPage(html("sel?.id === id && (sel = null, close('detail'))"), { files })).toEqual([]);
    const errors = (then: string, type?: string) => checkPage(html(then, type), { files }).map((d) => `${d.code} ${d.message.replace(/ \(TS\d+\)$/, '')}`);
    expect(errors('last = id')).toEqual(["SN208 Type 'number' is not assignable to type 'string'."]);
    expect(errors('sel?.id === uid && close(\'detail\')')).toEqual([expect.stringMatching(/^SN208 Property 'uid' does not exist on type 'Removed'/)]);
    expect(errors('last = id', '')).toEqual(['SN506 event `r` has no type: expressions reading its payload are not checked']);
  });

  test('<sn-resource then>: `$result` has the resource\'s type (`type`, or the action\'s result); state is checked', () => {
    const files = {
      'src/sinter.types.ts': TYPES,
      'src/sinter.actions.ts': `export async function pending(): Promise<{ subject: string; files: string[] } | null> { return null; }\n`,
    };
    const html = (then: string, call = '') => `<!doctype html><html><head></head><body>
<main data-sn-state="{ sel: /** @type {Contact|null} */ (null), subject: '' }">
<sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" type="Contact[]" then="${then}"></sn-resource>
<sn-resource name="p" call="pending()" then="${call}"></sn-resource>
<dialog id="compose"></dialog><p data-sn-text="contacts.length + (sel?.name ?? subject) + p?.subject"></p></main></body></html>`;
    const errors = (then: string, call = '') => checkPage(html(then, call), { files }).map((d) => `${d.code} ${d.message.replace(/ \(TS\d+\)$/, '')}`);
    expect(errors('sel = $result[0]', "$result && (subject = $result.subject, showModal('compose'))")).toEqual([]);
    expect(errors('subject = $result[0].id')).toEqual(["SN208 Type 'number' is not assignable to type 'string'."]);
    expect(errors('sel = $result')).toEqual([expect.stringMatching(/^SN208 Type 'Contact\[\]' is missing the following properties from type 'Contact'/)]);
    expect(errors('', 'subject = $result.files')).toEqual(["SN208 Type 'string[]' is not assignable to type 'string'."]);
  });

  test('URL templates: an array is refused in the path, allowed as a whole query value', () => {
    const html = (src: string) => page(`<main data-sn-state="{ ids: ['a'], id: 'a', n: 1, o: { x: 1 } }">
<sn-resource name="r" src="${src}" key="id" type="any"></sn-resource><p data-sn-text="contacts.length + r.length + ids + id + n + o"></p></main>`);
    expect(checkPage(html('/api/r/{id}/{n}/{o.x}?cal={ids}&q={id}'), { files: { 'src/sinter.types.ts': TYPES } })).toEqual([]);
    expect(checkPage(html('/api/r/{ids}'), { files: { 'src/sinter.types.ts': TYPES } }).map((d) => d.code + ' ' + d.message))
      .toEqual([expect.stringMatching(/^SN208 Type 'string\[\]' is not assignable to type 'PathValue'/)]);
  });

  test('<sn-resource call>: the result at `items` must fit `type`; without `type` it is the type', () => {
    const root = project({
      'src/sinter.types.ts': `${TYPES}export interface Body { text: string }\n`,
      'src/sinter.actions.ts': `export async function body(id: number): Promise<{ text: string }> { return { text: String(id) }; }
export async function list(): Promise<{ page: { contacts: { id: number; name: string; emails: string[] }[] } }> { return { page: { contacts: [] } }; }
`,
    });
    const p = projectOf(root);
    const run = (html: string) => {
      const file = join(root, 'index.html');
      writeFileSync(file, html);
      const out = compile(html, { file, root, dev: false, helpers: p.helpers, actions: p.actions, readFile: (f) => readFileSync(f, 'utf8'), check: true });
      return { out, r: check({ root, units: [out.check!], helpers: p.helpers, actions: p.actions, types: p.types, tsc }) };
    };
    const fits = run(`<sn-resource name="b" call="body(1)" type="Body"></sn-resource>
<sn-resource name="people" call="list()" items="page.contacts" key="id" type="Contact[]"></sn-resource>
<p data-sn-text="b.text + people.length"></p>`);
    expect(fits.out.diagnostics).toEqual([]);
    expect(fits.r.diagnostics).toEqual([]);

    const html = `<sn-resource name="b" call="body(1)" type="Contact"></sn-resource><p data-sn-text="b.name"></p>`;
    const wrong = run(html);
    expect(wrong.r.diagnostics).toHaveLength(1);
    expect(wrong.r.diagnostics[0]!.message).toMatch(/Type '\{ text: string; \}' is missing the following properties from type 'Contact'/);
    expect([wrong.r.diagnostics[0]!.line, wrong.r.diagnostics[0]!.col]).toEqual(at(html, 'Contact'));

    // no `type`: typed by the action, and no SN504 warning
    const untyped = run(`<sn-resource name="b" call="body(1)"></sn-resource><p data-sn-text="b.txt"></p>`);
    expect(untyped.out.diagnostics).toEqual([]);
    expect(untyped.r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/Property 'txt' does not exist on type '\{ text: string; \}'/)]);
  });

  test('data-sn-call: arguments checked against the action (minus its context), $result typed', () => {
    const root = project({
      'src/sinter.types.ts': TYPES,
      'src/sinter.actions.ts': `import type { CallContext } from '@tiaforge-ui/sinter';
import type { Contact } from './sinter.types.ts';
export * as mail from './mail.ts';
export async function rename(c: Contact, name: string, ctx: CallContext): Promise<Contact> { void ctx; return { ...c, name }; }
`,
      'src/mail.ts': `export async function count(n: number): Promise<{ total: number }> { return { total: n }; }\n`,
    });
    const p = projectOf(root);
    expect(p.actions.names).toEqual(['rename']);
    const html = page(`<div data-sn-state="{ label: '', total: 0 }">
<template data-sn-for="c in contacts">
  <button data-sn-call="rename(c, 'Ada')" data-sn-then="label = $result.name"></button>
  <button data-sn-call="rename(c, 5)"></button>
</template>
<button data-sn-call="mail.count(3)" data-sn-then="total = $result.totl"></button>
<form data-sn-call="mail.count($event.submitter.offsetTop + $event.timeStamp)"><button></button></form>
<form data-sn-call="mail.count($event.detail)" data-sn-trigger="pick"></form>
<form data-sn-call="mail.count($event.submiter)"></form>
<p data-sn-text="label + total"></p></div>`);
    const file = join(root, 'index.html');
    writeFileSync(file, html);
    const out = compile(html, { file, root, dev: false, helpers: p.helpers, actions: p.actions, readFile: (f) => readFileSync(f, 'utf8'), check: true });
    expect(out.diagnostics).toEqual([]);
    const r = check({ root, units: [out.check!], helpers: p.helpers, actions: p.actions, types: p.types, tsc });
    const msgs = r.diagnostics.map((d) => d.message).sort();
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatch(/Property 'submiter' does not exist on type 'SubmitEvent'/);
    expect(msgs[1]).toMatch(/Property 'totl' does not exist on type '\{ total: number; \}'/);
    expect(msgs[2]).toMatch(/'number' is not assignable to type 'string'/);
  });

  test('each: the loop variable has the list item type in src', () => {
    const html = page(`<sn-resource name="emails" each="c in contacts" src="/api/emails?contact={c.nmae}" key="id" type="any"></sn-resource>
<p data-sn-text="emails.length"></p>`);
    one(html, /Property 'nmae' does not exist on type 'Contact'/, 'nmae');
  });

  test('a TypeScript helpers module: calls are checked against its signatures', () => {
    const root = project({
      'src/sinter.types.ts': TYPES,
      'src/sinter.helpers.ts': `import type { Contact } from './sinter.types.ts';
export * as m from './messages.ts';
export const initial = (c: Contact): string => (c.name[0] ?? '?').toUpperCase();
`,
      'src/messages.ts': `export const items_count = (p: { count: number }): string => \`\${p.count} items\`;\n`,
    });
    const p = projectOf(root);
    expect(p.helpers).toEqual({ module: '/src/sinter.helpers.ts', names: ['initial'], namespaces: { m: { module: '/src/messages.ts', members: ['items_count'] } } });
    const html = page(`<ul><template data-sn-for="c in contacts"><li data-sn-text="initial(c) + m.items_count({ count: 1 })"></li></template></ul>
<p data-sn-text="initial(contacts.length)"></p>`);
    const file = join(root, 'index.html');
    writeFileSync(file, html);
    const out = compile(html, { file, root, dev: false, helpers: p.helpers, readFile: (f) => readFileSync(f, 'utf8'), check: true });
    expect(out.diagnostics).toEqual([]);
    const r = check({ root, units: [out.check!], helpers: p.helpers, types: p.types, tsc });
    expect(r.diagnostics.map((d) => d.message)).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toMatch(/'number' is not assignable to parameter of type 'Contact'/);
    expect([r.diagnostics[0]!.line, r.diagnostics[0]!.col]).toEqual(at(html, 'contacts.length'));
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

  test('events: typed payloads; `item` must fit the resource, `set` a part of it; cursor reads the item', () => {
    const types = TYPES + 'export interface ContactEvent { contact: Contact; id: number; patch: { name: number } }\n';
    const html = page(`<sn-resource name="feed" src="/api/feed" key="id" type="Contact[]" paginate="keyset" page-size="10" cursor="{ after: idd }"></sn-resource>
<p data-sn-text="contacts.length + feed.length"></p>
<sn-sync src="/api/events">
  <sn-event name="a" resource="contacts" op="upsert" item="contact" type="ContactEvent"></sn-event>
  <sn-event name="b" resource="contacts" op="upsert" item="id" type="ContactEvent"></sn-event>
  <sn-event name="c" resource="contacts" op="patch" set="{ name: patch.name }" type="ContactEvent"></sn-event>
  <sn-event name="d" resource="contacts" op="upsert" item="contct" type="ContactEvent"></sn-event>
  <sn-event name="e" resource="contacts" op="upsert" item="whatever" type="any"></sn-event>
</sn-sync>`);
    const r = run(html, { 'src/sinter.types.ts': types });
    expect(r.compile.filter((d) => d.severity === 'error' || d.code === 'SN506')).toEqual([]);
    expect(r.diagnostics.map((d) => [d.message.replace(/ (Did you mean .*)?\(TS\d+\)$/, ''), d.line, d.col])).toEqual([
      ["Property 'idd' does not exist on type 'Contact'.", ...at(html, '{ after: idd }')],
      ["Type 'number' is not assignable to type 'Contact'.", ...at(html, 'id" type="ContactEvent"></sn-event>\n  <sn-event name="c"')],
      ["Type 'number' is not assignable to type 'string'.", ...at(html, 'name: patch')],
      ["Property 'contct' does not exist on type 'ContactEvent'.", ...at(html, 'contct')],
    ]);
  });

  test('names the types module exports', () => {
    expect(typeExports(`export interface A {}
export declare type B<T> = T;
export class C {}
export { D, type E, F as G };
/** @typedef {{a: 1}} H */`)).toEqual(['A', 'B', 'C', 'D', 'E', 'G', 'H']);
  });

  test('the RealWorld example: untyped and typed from its OpenAPI spec, no false positives', () => {
    const root = join(import.meta.dirname, '../../examples/realworld');
    const pages = readdirSync(root).filter((f) => f.endsWith('.html'));
    for (const openapi of [undefined, 'openapi.yml']) {
      const p = projectOf(root, { openapi });
      expect(p.diagnostics).toEqual([]);
      const out = pages.map((f) => compile(p.readFile(join(root, f)), {
        file: join(root, f), root, dev: false, helpers: p.helpers, readFile: p.readFile, check: true, openapi: p.openapi,
      }));
      expect(out.flatMap((o) => o.diagnostics).filter((d) => d.code !== 'SN504')).toEqual([]);
      const units = out.map((o) => o.check!);
      const r = check({ root, units, helpers: p.helpers, types: null, tsc, outDir: mkdtempSync(join(tmpdir(), 'sinter-check-rw-')), openapi: p.openapi });
      expect(r.diagnostics).toEqual([]);
      expect(units.reduce((n, u) => n + u.exprs.length, 0)).toBeGreaterThan(300);
      expect([r.typed, r.openapi, r.resources]).toEqual(openapi ? [15, 15, 15] : [0, 0, 15]);
    }
  });
});

describe('OpenAPI types', () => {
  const ref = (n: string) => `$O.${n}`;
  test('schemas to TypeScript', () => {
    expect(schemaToTs({ type: 'object', required: ['id'], properties: { id: { type: 'integer' }, 'x-y': { type: 'string', nullable: true } } }, ref))
      .toBe('{ id: number; "x-y"?: string | null }');
    expect(schemaToTs({ type: ['string', 'null'] }, ref)).toBe('string | null');
    expect(schemaToTs({ type: 'array', items: { oneOf: [{ $ref: '#/components/schemas/A' }, { enum: ['b', 1] }] } }, ref)).toBe('($O.A | "b" | 1)[]');
    expect(schemaToTs({ allOf: [{ $ref: '#/components/schemas/A' }, { properties: { n: { const: 3 } } }] }, ref)).toBe('$O.A & { n?: 3 }');
    expect(schemaToTs({ type: 'object', additionalProperties: { type: 'number' } }, ref)).toBe('{ [key: string]: number }');
    expect(schemaToTs({ type: 'object' }, ref)).toBe('{ [key: string]: any }');
    expect(schemaToTs({ $ref: 'other.yml#/X' }, ref)).toBe('any');
    expect(schemaToTs({}, ref)).toBe('any');
  });

  test('named schemas: interfaces for objects, aliases otherwise', () => {
    expect(specDeclarations({ components: { schemas: { 'my.Item': { type: 'object', properties: { a: { type: 'string' } } }, Tag: { type: 'string' } } } }, 'api.yml'))
      .toBe('// Generated by `sinter check` from api.yml. Do not edit.\nexport {};\nexport interface my_Item { a?: string }\nexport type Tag = string;\n');
  });

  const SPEC = `openapi: 3.1.0
servers: [{ url: /api }]
paths:
  /contacts:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: object, properties: { contacts: { type: array, items: { $ref: '#/components/schemas/Person' } } } }
components:
  schemas:
    Person: { type: object, required: [id, name], properties: { id: { type: integer }, name: { type: string } } }
`;

  test('a resource without `type` is typed from the spec; messages name the schema', () => {
    const html = `<!doctype html><html><head></head><body>
<sn-resource name="people" src="/api/contacts" items="contacts" key="id"></sn-resource>
<sn-resource name="other" src="/api/contact"></sn-resource>
<ul><template data-sn-for="p in people"><li data-sn-text="p.nmae + other"></li></template></ul>
</body></html>`;
    const root = project({ 'openapi.yml': SPEC, 'index.html': html });
    const p = projectOf(root, { openapi: 'openapi.yml' });
    const file = join(root, 'index.html');
    const out = compile(html, { file, root, dev: false, helpers: p.helpers, readFile: p.readFile, check: true, openapi: p.openapi });
    expect(out.diagnostics.map((d) => [d.code, d.hint])).toEqual([
      ['SN504', 'no OpenAPI GET operation matches `src` (closest path: `/contacts`); add `type="…"`, or `type="any"` to leave it unchecked'],
    ]);
    const r = check({ root, units: [out.check!], helpers: p.helpers, types: null, tsc, openapi: p.openapi });
    expect(r.diagnostics.map((d) => d.message)).toEqual(["Property 'nmae' does not exist on type 'Person'. (TS2339)"]);
    expect([r.typed, r.openapi, r.resources]).toEqual([1, 1, 2]);
  });

  test('actions: the body is checked against the request schema, `$result` has the response type', () => {
    const spec = SPEC.replace('components:', `  /contacts/{id}:
    put:
      requestBody:
        content:
          application/json:
            schema: { type: object, required: [person], properties: { person: { $ref: '#/components/schemas/Person' } } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: object, properties: { person: { $ref: '#/components/schemas/Person' } } }
components:`);
    const html = `<!doctype html><html><head></head><body>
<sn-resource name="people" src="/api/contacts" items="contacts" key="id"></sn-resource>
<div data-sn-state="{ saved: '' }"><template data-sn-for="p in people">
  <button data-sn-put="/api/contacts/{p.id}" data-sn-body="{ person: { id: p.id, nam: 'x' } }" data-sn-then="saved = $result.person.nme">x</button>
</template></div>
</body></html>`;
    const root = project({ 'openapi.yml': spec, 'index.html': html });
    const p = projectOf(root, { openapi: 'openapi.yml' });
    const out = compile(html, { file: join(root, 'index.html'), root, dev: false, helpers: p.helpers, readFile: p.readFile, check: true, openapi: p.openapi });
    const r = check({ root, units: [out.check!], helpers: p.helpers, types: null, tsc, openapi: p.openapi });
    expect(r.diagnostics.map((d) => [d.message.match(/TS\d+/)![0], d.line, d.col])).toEqual([
      ['TS2561', ...at(html, 'nam:')],
      ['TS2551', ...at(html, 'nme')],
    ]);
  });

  test('SN307: a spec that is missing, not YAML, or not OpenAPI 3', () => {
    const root = project({ 'bad.yml': 'a: [', 'swagger.json': '{"swagger": "2.0", "paths": {}}' });
    expect(projectOf(root, { openapi: ['missing.yml', 'bad.yml', 'swagger.json'] }).diagnostics.map((d) => [d.code, d.message.replace(/: .*$/s, '')])).toEqual([
      ['SN307', 'OpenAPI spec `missing.yml` cannot be read'],
      ['SN307', 'OpenAPI spec `bad.yml` is not valid YAML'],
      ['SN307', 'OpenAPI spec `swagger.json` is not an OpenAPI 3 document (needs `openapi'],
    ]);
  });
});


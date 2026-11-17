import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { compile, readHelperManifest } from '../../src/compiler/index.js';
import { check, checkPage, findTsc, typeExports } from '../../src/check/index.js';
import { schemaToTs, specDeclarations } from '../../src/check/openapi-types.js';
import { shadow } from '../../src/check/shadow.js';
import { project as projectOf } from '../../src/project.js';
import { lazyHelpers } from '../../src/lazy-build.js';

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

  test('a form\'s $error is typed as the error or null, beside its own state', () => {
    one(page(`<form data-sn-post="/api/x" data-sn-state="{ n: 0 }"><p data-sn-text="$error ? $error.stauts : n"></p></form>`),
      /Property 'stauts' does not exist/, 'stauts');
  });

  test('state typed by a JSDoc cast; a handler assigns a wrong value', () => {
    one(page(`<div data-sn-state="{ editing: /** @type {Contact|null} */ (null) }">
  <button data-sn-on-click="editing = contacts[0]">ok</button>
  <button data-sn-on-click="editing = 5">wrong</button>
</div>`), /Type 'number' is not assignable to type 'Contact'/, 'editing = 5');
  });

  test('$error.stale is a boolean: the catch text for a stale page typechecks', () => {
    const r = run(page(`<div data-sn-state="{ msg: '' }"><button data-sn-post="/api/x" data-sn-catch="msg = $error.stale ? 'reload' : $error.message"></button><button data-sn-post="/api/y" data-sn-catch="msg = $error.stale"></button></div>`));
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/Type 'boolean' is not assignable to type 'string'/)]);
  });

  test('localeUrl() (localePrefix): a function from a language to a URL', () => {
    const locale = (html: string) => {
      const root = project({ 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.js': HELPERS, 'src/messages.js': MESSAGES });
      const file = join(root, 'index.html');
      writeFileSync(file, html);
      const out = compile(html, { file, root, dev: false, helpers, readFile: (p) => readFileSync(p, 'utf8'), check: true, locale: { name: 'de', urls: { de: '/de/', en: '/en/' }, base: '/' } });
      expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      return check({ root, units: [out.check!], helpers, types: join(root, 'src/sinter.types.ts'), tsc }).diagnostics.map((d) => d.message);
    };
    expect(locale(page(`<a hreflang="en" data-sn-attr="{ href: localeUrl('en') }">English</a>`))).toEqual([]);
    expect(locale(page(`<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n = localeUrl('en')"></button></div>`))).toEqual([expect.stringMatching(/Type 'string' is not assignable to type 'number'/)]);
  });

  test('$event and $el have the DOM types of the event and element', () => {
    one(page(`<div data-sn-state="{ q: '' }">
  <input data-sn-on-input="q = $el.value">
  <button data-sn-on-click="q = $event.button">x</button>
</div>`), /Type 'number' is not assignable to type 'string'/, 'q = $event');
    one(page(`<div data-sn-state="{ q: '' }"><input data-sn-on-input="q = $el.valu"></div>`), /Did you mean 'value'\?/, 'valu');
  });

  test('data-sn-on-navigate: $event is the navigation (to, from, kind, trigger)', () => {
    one(page(`<form data-sn-state="{ n: 0 }" data-sn-on-navigate="n = $event.to; $event.kind == 'traverse' && $event.preventDefault()"></form>`), /Type 'string' is not assignable to type 'number'/, 'n = $event');
    one(page(`<form data-sn-state="{ s: '' }" data-sn-on-navigate="s = $event.too"></form>`), /Property 'too' does not exist/, 'too');
  });

  test('custom elements: data-sn-prop, $el and $event.detail are typed by the app\'s declarations under src/', () => {
    const island = { 'src/islands/mail-reader.ts': `export class MailReader extends HTMLElement { message: Contact | null = null; readonly = false; }
import type { Contact } from '../sinter.types';
declare global {
  interface HTMLElementTagNameMap { 'mail-reader': MailReader }
  interface SinterElementEvents { 'mail-reader': { 'reader-flag': boolean } }
}
` };
    const ok = page(`<div data-sn-state="{ flag: false, name: '' }">
  <mail-reader data-sn-prop="{ message: contacts[0], readonly: true }" data-sn-on-reader-flag="flag = $event.detail; name = $el.message.name"></mail-reader>
  <other-thing data-sn-prop="{ anything: 1 }" data-sn-on-ping="name = $event.detail"></other-thing>
</div>`);
    expect(run(ok, island).diagnostics).toEqual([]);
    one(page(`<mail-reader data-sn-prop="{ mesage: contacts[0] }"></mail-reader>`), /'mesage' does not exist/, 'mesage', island);
    one(page(`<mail-reader data-sn-prop="{ readonly: 'yes' }"></mail-reader>`), /Type 'string' is not assignable to type 'boolean'/, "readonly: 'yes'", island);
    one(page(`<div data-sn-state="{ n: 0 }"><mail-reader data-sn-on-reader-flag="n = $event.detail"></mail-reader></div>`), /Type 'boolean' is not assignable to type 'number'/, 'n = $event', island);
  });

  test('components: props typed by data-sn-component at the call site and inside, $event.detail by data-sn-emits', () => {
    const card = { 'src/components/contact-card.html': `<template data-sn-component="{ contact: Contact; compact?: boolean }" data-sn-emits="{ pick: Contact }">
  <div><h2 data-sn-text="contact.name"></h2><button data-sn-on-click="emit('pick', contact)"></button></div>
</template>` };
    const ok = page(`<div data-sn-state="{ sel: /** @type {Contact|null} */ (null) }">
  <template data-sn-for="c in contacts"><contact-card data-sn-prop="{ contact: c }" data-sn-on-pick="sel = $event.detail"></contact-card></template>
</div>`);
    expect(run(ok, card).diagnostics).toEqual([]);
    one(page(`<contact-card data-sn-prop="{ contact: contacts[0], compact: 'yes' }"></contact-card>`), /Type 'string' is not assignable to type 'boolean'/, "compact: 'yes'", card);
    one(page(`<div data-sn-state="{ n: 0 }"><contact-card data-sn-prop="{ contact: contacts[0] }" data-sn-on-pick="n = $event.detail"></contact-card></div>`),
      /Type 'Contact' is not assignable to type 'number'/, 'n = $event', card);
    const typo = { 'src/components/contact-card.html': card['src/components/contact-card.html'].replace('contact.name', 'contact.nmae') };
    const r = run(page(`<contact-card data-sn-prop="{ contact: contacts[0] }"></contact-card>`), typo);
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/Property 'nmae' does not exist on type 'Contact'/)]);
    expect(r.diagnostics[0]!.file).toMatch(/src\/components\/contact-card.html$/);
  });

  test('head components: props typed by data-sn-head at the call site and inside', () => {
    const seo = { 'src/components/seo-tags.html': `<template data-sn-head="{ contact: Contact; count?: number }">
  <title data-sn-text="contact.name"></title>
</template>` };
    const html = (use: string) => `<!doctype html><html><head>
${use}
</head><body><sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" type="Contact[]"></sn-resource></body></html>`;
    expect(run(html('<seo-tags data-sn-prop="{ contact: contacts[0] }"></seo-tags>'), seo).diagnostics).toEqual([]);
    one(html(`<seo-tags data-sn-prop="{ contact: contacts[0], count: 'x' }"></seo-tags>`), /Type 'string' is not assignable to type 'number'/, "count: 'x'", seo);
    const typo = { 'src/components/seo-tags.html': seo['src/components/seo-tags.html'].replace('contact.name', 'contact.nmae') };
    const r = run(html('<seo-tags data-sn-prop="{ contact: contacts[0] }"></seo-tags>'), typo);
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/Property 'nmae' does not exist on type 'Contact'/)]);
    expect(r.diagnostics[0]!.file).toMatch(/src\/components\/seo-tags.html$/);
  });

  test('layouts: props typed by data-sn-layout at the page\'s tag and inside the layout, the page\'s state in its slots', () => {
    const layout = { 'src/layouts/site-layout.html': `<!doctype html>
<html data-sn-layout="{ contact: Contact; count?: number }">
<head><title data-sn-text="contact.name"></title><slot name="head"></slot></head>
<body><slot></slot></body>
</html>` };
    const html = (tag: string, body = '') => `<site-layout ${tag}>
<sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" type="Contact[]"></sn-resource>
${body}
</site-layout>`;
    expect(run(html('data-sn-prop="{ contact: contacts[0] }"'), layout).diagnostics).toEqual([]);
    one(html(`data-sn-prop="{ contact: contacts[0], count: 'x' }"`), /Type 'string' is not assignable to type 'number'/, "count: 'x'", layout);
    one(html('data-sn-state="{ n: 0 }" data-sn-prop="{ contact: contacts[0] }"', '<p data-sn-text="n.toFixed(1).nope"></p>'), /Property 'nope' does not exist on type 'string'/, 'nope', layout);
    const typo = { 'src/layouts/site-layout.html': layout['src/layouts/site-layout.html'].replace('contact.name', 'contact.nmae') };
    const r = run(html('data-sn-prop="{ contact: contacts[0] }"'), typo);
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/Property 'nmae' does not exist on type 'Contact'/)]);
    expect(r.diagnostics[0]!.file).toMatch(/src\/layouts\/site-layout.html$/);
  });

  test('<sn-component use>: the name must fit ComponentName; props are checked per candidate, narrowed by the key', () => {
    const types = `export interface Hero { id: number; type: 'hero'; title: string }
export interface Text { id: number; type: 'text'; body: string }
export interface Image { id: number; type: 'image'; src: string }
export type Block = Hero | Text;
export type AnyBlock = Hero | Text | Image;
`;
    const files = {
      'src/sinter.types.ts': types,
      'src/components/hero-block.html': '<template data-sn-component="{ block: Hero }"><h1 data-sn-text="block.title"></h1></template>',
      'src/components/text-block.html': '<template data-sn-component="{ block: Text }"><p data-sn-text="block.body"></p></template>',
    };
    const html = (t: string, use: string) => `<!doctype html><html><head></head><body>
<sn-resource name="blocks" src="/api/b" key="id" type="${t}[]"></sn-resource>
<template data-sn-for="b in blocks"><sn-component use="${use}" data-sn-prop="{ block: b }"></sn-component></template>
</body></html>`;
    const run2 = (t: string, use: string) => checkPage(html(t, use), { files }).map((d) => `${d.code} ${d.message.replace(/ \(TS\d+\)$/, '')}`);
    // narrowed per candidate: hero-block gets a Hero, text-block a Text
    expect(run2('Block', '`${b.type}-block`')).toEqual([]);
    expect(run2('Block', "{ hero: 'hero-block', text: 'text-block' }[b.type]")).toEqual([]);
    // a type the spec has and no component: the name does not fit ComponentName
    expect(run2('AnyBlock', '`${b.type}-block`')).toEqual([expect.stringMatching(/Type '"image-block"' is not assignable to type '"hero-block" \| "text-block"'/)]);
    expect(run2('AnyBlock', "{ hero: 'hero-block', text: 'text-block' }[b.type]")).toEqual([expect.stringMatching(/Type '"image"' is not assignable to type '"hero" \| "text"'/)]);
  });

  test('branches narrow: a data-sn-if is checked under its condition, its data-sn-else under the negation, a choice\'s else under no candidate', () => {
    const types = `export interface Plain { type: 'plain'; value: string }
export interface Strong { type: 'strong'; children: Inline[] }
export interface Ref { type: 'ref'; url: string; children: Inline[] }
export type Inline = Plain | Strong | Ref;
`;
    const files = {
      'src/sinter.types.ts': types,
      'src/components/x-strong.html': '<template data-sn-component="{ node: Strong }"><b data-sn-text="node.children.length"></b></template>',
      'src/components/x-ref.html': '<template data-sn-component="{ node: Ref }"><a data-sn-attr="{ href: node.url }"></a></template>',
    };
    const html = (body: string) => `<!doctype html><html><head></head><body>
<sn-resource name="nodes" src="/api/n" type="Inline[]"></sn-resource>
<template data-sn-for="n in nodes">${body}</template>
</body></html>`;
    const errors = (body: string) => checkPage(html(body), { files }).map((d) => `${d.code} ${d.message.replace(/ \(TS\d+\)$/, '')}`);
    // the map's other keys render the else, where n is the union's other member
    const choice = `<sn-component use="{ strong: 'x-strong', ref: 'x-ref' }[n.type]" data-sn-prop="{ node: n }"></sn-component><template data-sn-else><template data-sn-text="n.value"></template></template>`;
    expect(errors(choice)).toEqual([]);
    // without a data-sn-else, a key outside the map is still an error
    expect(errors(`<sn-component use="{ strong: 'x-strong', ref: 'x-ref' }[n.type]" data-sn-prop="{ node: n }"></sn-component>`))
      .toEqual([expect.stringMatching(/Type '"plain"' is not assignable to type '"ref" \| "strong"'/)]);
    // an else is not a candidate: n there is not narrowed to a candidate's member
    expect(errors(`<sn-component use="{ strong: 'x-strong' }[n.type]" data-sn-prop="{ node: n }"></sn-component><template data-sn-else><template data-sn-text="n.value"></template></template>`))
      .toEqual([expect.stringMatching(/Property 'value' does not exist on type 'Ref'/)]);
    // an if chain: each branch under its condition, the else under the negation of the ones before
    const chain = `<template data-sn-if="n.type === 'plain'"><span data-sn-text="n.value"></span></template><template data-sn-else><template data-sn-if="n.type === 'ref'"><a data-sn-attr="{ href: n.url }" data-sn-text="n.children.length"></a></template><template data-sn-else><b data-sn-state="{ k: 0 }" data-sn-on-click="k = n.children.length" data-sn-text="k"></b></template></template>`;
    expect(errors(chain)).toEqual([]);
    // outside the branch, nothing is narrowed
    expect(errors(`<template data-sn-if="n.type === 'plain'"><span data-sn-text="n.value"></span></template><i data-sn-text="n.value"></i>`))
      .toEqual([expect.stringMatching(/Property 'value' does not exist on type 'Inline'|Property 'value' does not exist on type 'Strong'/)]);
    // an error in a condition is reported once, at the condition
    expect(errors(`<template data-sn-if="n.tpye === 'plain'"><span data-sn-text="n.type"></span></template>`))
      .toEqual([expect.stringMatching(/Property 'tpye' does not exist/)]);
  });

  test('SN538: a candidate the branches around rule out is a warning at its key, not an error in generated code', () => {
    const types = `export interface Para { type: 'para'; text: string }
export interface Quote { type: 'quote'; text: string }
export interface Rule { type: 'rule' }
export type Block = Para | Quote | Rule;
`;
    const files = {
      'src/sinter.types.ts': types,
      'src/components/x-para.html': '<template data-sn-component="{ node: Para }"><p data-sn-text="node.text"></p></template>',
      'src/components/x-quote.html': '<template data-sn-component="{ node: Quote }"><blockquote data-sn-text="node.text"></blockquote></template>',
    };
    const use = `{ para: 'x-para', quote: 'x-quote' }[b.type]`;
    const html = `<!doctype html><html><head></head><body>
<sn-resource name="blocks" src="/api/b" type="Block[]"></sn-resource>
<template data-sn-for="b in blocks"><template data-sn-if="b.type === 'para'"><p data-sn-text="b.text"></p></template><template data-sn-else><sn-component use="${use}" data-sn-prop="{ node: b }"></sn-component><template data-sn-else><hr></template></template></template>
</body></html>`;
    const d = checkPage(html, { files });
    expect(d.map((x) => `${x.severity} ${x.code} ${x.message}`)).toEqual(['warning SN538 `x-para` can never be chosen here: `b.type` cannot be `"para"` where this `<sn-component>` is (a branch around it rules it out)']);
    expect([d[0]!.line, d[0]!.col]).toEqual(at(html, "para: 'x-para'"));
    // reachable candidates: nothing
    expect(checkPage(html.replace("<template data-sn-if=\"b.type === 'para'\"><p data-sn-text=\"b.text\"></p></template><template data-sn-else>", '<template data-sn-if="true">'), { files })).toEqual([]);
  });

  test('SN507 complex expressions: in checkPage like other diagnostics, with the complexity option', () => {
    const html = page(`<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n = 1; n = 2; n = 3; n = 4; n = 5" data-sn-text="n + contacts.length"></button></div>`);
    const d = checkPage(html, { files: { 'src/sinter.types.ts': TYPES } });
    expect(d.map((x) => `${x.severity} ${x.code} ${x.file}:${x.line}`)).toEqual(['warning SN507 index.html:3']);
    expect(checkPage(html, { files: { 'src/sinter.types.ts': TYPES }, complexity: { level: 'error' } }).map((x) => x.severity)).toEqual(['error']);
    expect(checkPage(html, { files: { 'src/sinter.types.ts': TYPES }, complexity: { statements: 5 } })).toEqual([]);
  });

  test('$error passes to a helper that takes a SinterError (an Error: name, stack)', () => {
    const pkg = {
      'node_modules/@tiaforge-ui/sinter/package.json': '{"name":"@tiaforge-ui/sinter","types":"index.d.ts"}',
      'node_modules/@tiaforge-ui/sinter/index.d.ts': 'export declare class SinterError extends Error { readonly status: number | null; readonly body: unknown; readonly detail: string | null; readonly stale: boolean; constructor(status: number | null, body: unknown, message: string, detail?: string | null, stale?: boolean); }',
    };
    const helpers = `/** @param {import('@tiaforge-ui/sinter').SinterError} e */\nexport function say(e) { return \`\${e.name}: \${e.message}\`; }\n`;
    const html = page(`<div data-sn-state="{ msg: '' }"><button data-sn-post="/api/x" data-sn-catch="msg = say($error) + ($error.stack ?? '')" data-sn-text="contacts.length + msg"></button></div>`);
    expect(checkPage(html, { files: { 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.js': helpers, ...pkg } })).toEqual([]);
  });

  test('refresh() with several names types each against the page\'s resources', () => {
    const html = page(`<sn-resource name="other" src="/api/o" type="any"></sn-resource><button data-sn-on-click="refresh('contacts', 'other')" data-sn-text="contacts.length + other"></button>`);
    expect(checkPage(html, { files: { 'src/sinter.types.ts': TYPES } })).toEqual([]);
  });

  test('a static page: a component prop in a loop over constants keeps its loop variable (the check reads the page as written, not unrolled)', () => {
    // a benchmark agent's `sinter check` failed 13 times with "Cannot find name 'p'" and it dropped `static: true` to pass
    const root = project({ 'src/components/post-item.html': '<template data-sn-component="{ post: { title: string } }"><li data-sn-text="post.title"></li></template>' });
    const page = (prop: string) => `<!doctype html><html><head><title>x</title></head><body><ul data-sn-state="{ posts: [{ title: 'a' }, { title: 'b' }] }"><template data-sn-for="p in posts"><post-item data-sn-prop="{ post: ${prop} }"></post-item></template></ul></body></html>`;
    const errors = (prop: string) => {
      const file = join(root, 'index.html'), html = page(prop);
      writeFileSync(file, html);
      const h = { module: null, names: [], namespaces: {} };
      const out = compile(html, { file, root, dev: false, helpers: h, readFile: (p) => readFileSync(p, 'utf8'), check: true, componentNames: ['post-item'], prerender: true, static: true });
      return [...out.diagnostics, ...check({ root, units: [out.check!], helpers: h, types: null, tsc }).diagnostics].filter((d) => d.severity === 'error').map((d) => d.message.replace(/ \(TS\d+\)$/, ''));
    };
    expect(errors('p')).toEqual([]);
    // and a real mistake in the loop is still found
    expect(errors('{ titel: p.title }')).toEqual([expect.stringMatching(/'titel' does not exist|Object literal may only specify known properties/)]);
  });

  test('`$event.target.value`: the SN208 names `$el.value` and data-sn-model; `$el.value` passes', () => {
    const html = (h: string) => page(`<div data-sn-state="{ q: '' }"><input data-sn-on-input="${h}" data-sn-text="q + contacts.length"></div>`);
    const d = checkPage(html('q = $event.target.value'), { files: { 'src/sinter.types.ts': TYPES } });
    expect(d.map((x) => [x.code, x.message.replace(/ \(TS\d+\)$/, '')])).toEqual([['SN208', "Property 'value' does not exist on type 'EventTarget'."]]);
    expect(d[0]!.hint).toBe('`$event.target` is any EventTarget to TypeScript: read the element the handler is on with `$el.value` (typed by its tag), or bind the field with `data-sn-model`');
    expect(checkPage(html('q = $el.value'), { files: { 'src/sinter.types.ts': TYPES } })).toEqual([]);
    // on an ancestor `$el` is the ancestor (a form takes any name, so `$el.value` would type-check and read the wrong
    // thing): the hint moves the handler, or narrows the target
    const on = (el: string) => checkPage(page(`<div data-sn-state="{ q: '' }">${el}<p data-sn-text="q + contacts.length"></p></div>`), { files: { 'src/sinter.types.ts': TYPES } })[0]?.hint;
    expect(on('<form data-sn-on-input="q = $event.target.value"><input name="a"></form>')).toMatch(/whatever the event started on inside this `<form>`: put the handler on that element .* \(\$event\.target\)\.value`$/);
    expect(on('<ul data-sn-on-click="q = $event.target.dataset.id"><li data-id="1">a</li></ul>')).toMatch(/inside this `<ul>`.*read the row's item instead of `dataset`/);
    expect(checkPage(page(`<div data-sn-state="{ q: '' }"><form data-sn-on-input="q = /** @type {HTMLInputElement} */ ($event.target).value"><input name="a"></form><p data-sn-text="q + contacts.length"></p></div>`), { files: { 'src/sinter.types.ts': TYPES } })).toEqual([]);
  });

  test('page() with a computed target: a direction on keyset; a page number needs offset-param', () => {
    const helpers = `/** @param {boolean} back @returns {'next' | 'prev'} */\nexport function step(back) { return back ? 'prev' : 'next'; }\n`;
    const html = (to: string, attrs = '') => page(`<sn-resource name="list" src="/api/l" key="id" type="Contact[]" paginate="keyset" page-size="5" cursor="{id}" ${attrs}></sn-resource>
<div data-sn-state="{ n: 2, word: 'next' }"><button data-sn-on-click="page('list', ${to})" data-sn-text="contacts.length + list.length + n + word"></button></div>`);
    const errors = (to: string, attrs = '') => checkPage(html(to, attrs), { files: { 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.js': helpers } }).map((d) => `${d.code} ${d.message.replace(/ \(TS\d+\)$/, '')}`);
    expect(errors(`$event.shiftKey ? 'prev' : 'next'`)).toEqual([]);
    expect(errors('step($event.shiftKey)')).toEqual([]);
    expect(errors('n')).toEqual([`SN208 Argument of type 'number' is not assignable to parameter of type '"a keyset resource takes a direction; add offset-param for page numbers" | Direction'.`]);
    expect(errors('word')).toEqual([`SN208 Argument of type 'string' is not assignable to parameter of type '"a keyset resource takes a direction; add offset-param for page numbers" | Direction'.`]);
    // with offset-param, a page number is a target too
    expect(errors('n', 'offset-param="offset"')).toEqual([]);
    expect(errors('word', 'offset-param="offset"')).toEqual([`SN208 Argument of type 'string' is not assignable to parameter of type 'number | Direction'.`]);
  });

  test('resource names from ?: and lets: page() targets suit every name; items fit any of them', () => {
    const types = TYPES + 'export interface Message { uid: number; subject: string }\n';
    const html = (lets: string, h: string) => page(`<sn-resource name="messages" src="/api/m" key="uid" type="Message[]" paginate="keyset" page-size="5" cursor="{uid}"></sn-resource>
<sn-resource name="results" src="/api/r" key="uid" type="Message[]" paginate="offset" page-size="5"></sn-resource>
<sn-resource name="jumps" src="/api/j" key="uid" type="Message[]" paginate="keyset" page-size="5" cursor="{uid}" offset-param="offset"></sn-resource>
<div data-sn-state="{ s: false, n: 2, m: /** @type {Message} */ ({ uid: 1, subject: '' }) }" data-sn-let="${lets}"><button data-sn-on-click="${h}" data-sn-text="contacts.length + messages.length + results.length + jumps.length"></button></div>`);
    const errors = (lets: string, h: string) => checkPage(html(lets, h), { files: { 'src/sinter.types.ts': types } }).map((d) => `${d.code} ${d.message.replace(/ \(TS\d+\)$/, '')}`);
    // a let of one literal is that name, not \`string\`
    expect(errors(`{ one: 'messages' }`, `page(one, 'next'); refresh(one)`)).toEqual([]);
    expect(errors(`{ shown: s ? 'results' : 'messages' }`, `page(shown, s ? 'prev' : 'next'); refresh(shown, 'contacts'); upsert(shown, m)`)).toEqual([]);
    expect(errors(`{ a: 'results', b: s ? a : 'jumps' }`, `page(b, n)`)).toEqual([]);
    // a page number where one of the names is keyset without offset-param
    expect(errors(`{ shown: s ? 'results' : 'messages' }`, `page(shown, n)`)).toEqual([`SN208 Argument of type 'number' is not assignable to parameter of type '"a keyset resource takes a direction; add offset-param for page numbers" | Direction'.`]);
    // an item that fits one of the names
    expect(errors(`{ shown: s ? 'contacts' : 'messages' }`, `upsert(shown, m); remove(contacts[0])`)).toEqual([]);
    expect(errors(`{ shown: s ? 'results' : 'messages' }`, `upsert(shown, contacts[0])`)).toHaveLength(1);
  });

  test('a key filter\'s $event is the KeyboardEvent of its keydown or keyup', () => {
    one(page(`<div data-sn-state="{ q: '', n: 0 }" data-sn-on-keydown-shift-j="q = $event.key" data-sn-on-keyup-escape="n = $event.code">
  <p data-sn-text="q + n"></p>
</div>`), /Type 'string' is not assignable to type 'number'/, 'n = $event');
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

  test('sn-event: `data-sn-let` names around the sync are in scope like state, in `when` and `then`', () => {
    const types = `${TYPES}export interface Updated { uid: number; mailbox: string; seen: boolean }\n`;
    // the let is the innermost frame (`open`) or under a state (`box`); both once gave errors here
    const sync = (attrs: string) => page(`<main data-sn-state="{ sel: /** @type {Contact|null} */ (null), n: 0 }" data-sn-let="{ open: sel, box: 'inbox' }">
<div data-sn-state="{ last: '' }">
<sn-sync src="/api/events"><sn-event name="u" type="Updated" ${attrs}></sn-event></sn-sync>
<p data-sn-text="contacts.length + n + last + open?.name + box"></p></div></main>`);
    const errors = (attrs: string) => checkPage(sync(attrs), { files: { 'src/sinter.types.ts': types } }).map((d) => `${d.code} ${d.message.replace(/ \(TS\d+\)$/, '')}`);
    expect(errors(`when="mailbox === box" then="open && open.id === uid && n++; last = open?.name ?? last"`)).toEqual([]);
    expect(errors(`then="last = open.id"`)).toEqual(["SN208 Type 'number' is not assignable to type 'string'."]);
    expect(errors(`then="n = box.lenght"`)).toEqual([expect.stringMatching(/^SN208 Property 'lenght' does not exist on type 'string'/)]);
    // a let named like a field of the typed payload hides it: an error, as for state
    const shadowing = page(`<main data-sn-state="{ n: 0 }" data-sn-let="{ seen: n > 0 }">
<sn-sync src="/api/events"><sn-event name="u" type="Updated" then="seen && n++"></sn-event></sn-sync>
<p data-sn-text="contacts.length + n + (seen ? 1 : 0)"></p></main>`);
    expect(checkPage(shadowing, { files: { 'src/sinter.types.ts': types } }).map((d) => d.message))
      .toEqual([expect.stringMatching(/`data-sn-let` name `seen` shadows the payload field `seen`: rename it/)]);
  });

  test('sn-event `then`: the typed payload and the state are checked; SN506 without a type', () => {
    const files = { 'src/sinter.types.ts': `${TYPES}export interface Removed { id: number }\n` };
    const html = (then: string, type = ' type="Removed"') => page(`<main data-sn-state="{ sel: /** @type {Contact|null} */ (null), last: '' }">
<sn-sync src="/api/events"><sn-event name="r" resource="contacts" op="remove"${type} then="${then}"></sn-event></sn-sync>
<dialog id="detail"></dialog><p data-sn-text="contacts.length + (sel?.name ?? last)"></p></main>`);
    expect(checkPage(html("sel?.id === id && close('detail'); sel = sel?.id === id ? null : sel"), { files })).toEqual([]);
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
    expect(errors('sel = $result[0]', "subject = $result?.subject ?? subject; $result && showModal('compose')")).toEqual([]);
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
  <button data-sn-on-click="patch(c, { name: 'x' })">ok</button>
  <button data-sn-on-click="patch(c, { nme: 'x' })">typo</button>
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

  test('a component maps to its own file, with where it is used', () => {
    const row = '<template data-sn-component="{ c: Contact }"><li>\n  <b data-sn-text="c.emial"></b></li></template>';
    const r = run(page('<ul><template data-sn-for="c in contacts"><contact-row data-sn-prop="{ c }"></contact-row></template></ul>'), { 'src/components/contact-row.html': row });
    expect(r.compile).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0]!;
    expect(d.file).toBe(join(r.root, 'src/components/contact-row.html'));
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

  test('the export scanner skips comments and strings', () => {
    // Caley: a comment in src/sinter.types.ts showed how to re-export, and its names were taken as exports
    expect(typeExports(`// export type { Draft } from './compose';
/* export interface Old {}
   export { Gone } */
/**
 * Re-export with \`export type { X } from './x'\`.
 * @typedef {{a: 1}} H
 */
const hint = 'export type { Fake }';
const t = \`export interface Tpl {}\`;
const url = "https://x//y"; export interface Real { s: '/*' }
export type { Kept } from './kept'; // export { Trailing }
export type Also = '*/';`)).toEqual(['Also', 'H', 'Kept', 'Real']);
  });

  test('the RealWorld example with its APIs (`examples/realworld/apis.js`): typed from its spec, no false positives', async () => {
    const root = join(import.meta.dirname, '../../examples/realworld');
    const pages = readdirSync(root).filter((f) => f.endsWith('.html'));
    // the example's config module (its Vite config imports it; CI does not install the example's dependencies)
    const config = '../../examples/realworld/apis.js';
    const { apis } = (await import(config)) as { apis: NonNullable<Parameters<typeof projectOf>[1]>['apis'] };
    // its component library, as its Vite config lists it: linked from packages/ (`file:`), the link `npm ci` makes
    const lib = join(root, 'node_modules/@tiaforge-ui/sinter-markdown');
    if (!existsSync(lib)) {
      mkdirSync(dirname(lib), { recursive: true });
      symlinkSync('../../../../packages/sinter-markdown', lib, 'dir');
    }
    // as its Vite config sets them (without SINTER_EMBED): the library, loaded with the page
    const p = projectOf(root, { apis, components: ['@tiaforge-ui/sinter-markdown'] });
    const lazyModule = lazyHelpers(root, p.lazy, undefined, p.libraries).reach;
    expect(p.diagnostics).toEqual([]);
    const out = pages.map((f) => compile(p.readFile(join(root, f)), {
      file: join(root, f), root, dev: false, helpers: p.helpers, readFile: p.readFile, check: true, openapi: p.openapi, apis: p.apis, lazyModule, lazy: p.lazy, componentNames: p.componentNames, libraries: p.libraries,
    }));
    expect(out.flatMap((o) => o.diagnostics)).toEqual([]);
    const units = out.map((o) => o.check!);
    const r = check({ root, units, helpers: p.helpers, types: null, tsc, outDir: join(root, '.sinter/check-test'), openapi: p.openapi, libraries: p.libraries });
    expect(r.diagnostics).toEqual([]);
    expect(units.reduce((n, u) => n + u.exprs.length, 0)).toBeGreaterThan(300);
    expect([r.typed, r.openapi, r.resources]).toEqual([15, 15, 15]);
  }, 30_000);
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
    expect(projectOf(root, { openapi: ['missing.yml', 'bad.yml', 'swagger.json'] }).diagnostics.filter((d) => d.code === 'SN307').map((d) => [d.code, d.message.replace(/: .*$/s, '')])).toEqual([
      ['SN307', 'OpenAPI spec `missing.yml` cannot be read'],
      ['SN307', 'OpenAPI spec `bad.yml` is not valid YAML'],
      ['SN307', 'OpenAPI spec `swagger.json` is not an OpenAPI 3 document (needs `openapi'],
    ]);
  });
});


describe('slots that pass data', () => {
  const table = (placement = '{ contact: c, column: k }') => ({ 'src/components/contact-table.html': `<template data-sn-component="{ rows: Contact[]; columns: (keyof Contact)[]; cell: Slot<{ contact: Contact; column: keyof Contact }> }">
  <table><template data-sn-for="c in rows"><tr><template data-sn-for="k in columns"><td><slot name="cell" data-sn-prop="${placement}"><span data-sn-text="c[k]"></span></slot></td></template></tr></template></table>
</template>` });
  const use = (fill: string) => page(`<contact-table data-sn-prop="{ rows: contacts, columns: ['name'] }">${fill}</contact-table>`);

  test('`$slot` in the fill is typed by the slot\'s T', () => {
    expect(run(use('<b slot="cell" data-sn-text="$slot.contact.name + $slot.column"></b>'), table()).diagnostics).toEqual([]);
    expect(run(use(''), table()).diagnostics).toEqual([]);
    one(use('<b slot="cell" data-sn-text="$slot.contact.nmae"></b>'), /Property 'nmae' does not exist on type 'Contact'/, 'nmae', table());
  });

  test('the placement\'s data-sn-prop is checked against T, in the component', () => {
    const r = run(use(''), table('{ contact: c, column: 1 }'));
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/Type 'number' is not assignable to type 'keyof Contact'/)]);
    expect(r.diagnostics[0]!.file).toMatch(/src\/components\/contact-table.html$/);
  });

  test('a Slot<T> in a type alias is an error', () => {
    const types = `${TYPES}export type CellProps = { cell: Slot<{ n: number }> };\n`;
    const r = run(page('<x-cell></x-cell>'), { 'src/sinter.types.ts': types, 'src/components/x-cell.html': '<template data-sn-component="CellProps"><div data-sn-text="1"></div></template>' });
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/a Slot<T> member is in a type alias: write the props as a type literal/)]);
  });
});

describe('a let that waits for a lazy helper module (docs/lazy.md#helpers-that-wait)', () => {
  const files = {
    'src/sinter.helpers.ts': "export * as crunch from './lib/crunch.ts';\nexport * as toc from './lib/toc.ts';\n",
    'src/lib/crunch.ts': "import { lexer } from 'fakelib';\nexport interface Doc { words: string[] }\nexport function parse(s: string): Doc { return { words: lexer(s) }; }\n",
    'src/lib/toc.ts': 'export function count(s: string): number { return s.length; }\n',
    'node_modules/fakelib/package.json': '{"name":"fakelib","types":"index.d.ts"}',
    'node_modules/fakelib/index.d.ts': 'export declare function lexer(s: string): string[];',
  };
  const html = (body: string) => `<!doctype html><html><head></head><body data-sn-state="{ src: 'a b' }">${body}</body></html>`;
  const run = (body: string) => checkPage(html(body), { files, lazy: ['fakelib'] }).map((d) => `${d.code} ${d.line}:${d.col} ${d.message.replace(/ \(TS\d+\)$/, '')}`);

  test('typed `T | undefined` (the shadow file); a module that does not reach the package keeps ordinary helpers', () => {
    expect(run('<main data-sn-let="{ doc: crunch.parse(src) }"><p data-sn-text="(doc?.words.length ?? 0) + toc.count(src)"></p></main>')).toEqual([]);
    const helpers = { module: '/src/sinter.helpers.ts', names: [], namespaces: { crunch: { module: '/src/lib/crunch.ts', members: ['parse'] } } };
    const out = compile(html('<main data-sn-let="{ doc: crunch.parse(src), n: 1 }"><p data-sn-text="doc && n"></p></main>'),
      { file: '/p/index.html', root: '/p', dev: false, check: true, helpers, readFile: () => { throw new Error('none'); }, lazyModule: (m) => (m === '/src/lib/crunch.ts' ? ['fakelib'] : []) });
    const text = shadow({ unit: out.check!, file: '/p/.sinter/index.js', root: '/p', declarations: '/p/.sinter/sinter.d.ts', types: null, helpers }).text;
    expect(text).toMatch(/const doc = \$waits\(\$e\d+\(\)\);/);
    expect(text).toMatch(/const n = \$e\d+\(\);/);
    expect(text).toContain('@returns {T | undefined}');
  });

  test('SN324 at a call outside a let or a prop, per module, with the hint', () => {
    const d = checkPage(html('<p data-sn-text="crunch.parse(src).words.length + toc.count(src)"></p>'), { files, lazy: ['fakelib'] });
    expect(d.map((x) => `${x.code} ${x.line}:${x.col}`)).toEqual(['SN324 1:89']);
    expect(d[0]!.message).toContain('`crunch.parse` is declared in a module that reaches a lazy package');
    expect(d[0]!.hint).toContain('data-sn-let="{ doc: crunch.parse(…) }"');
  });
});

describe('file: resources, checked against their files', () => {
  const POST_TYPES = 'export interface Post { title: string; date: string; tags?: string[] }\n';
  function runFiles(html: string, files: Record<string, string>) {
    const root = project({ 'src/sinter.types.ts': POST_TYPES, ...files });
    const file = join(root, 'index.html');
    writeFileSync(file, html);
    const p = projectOf(root);
    const out = compile(html, { file, root, dev: false, helpers: p.helpers, readFile: p.readFile, listFiles: p.listFiles, check: true });
    const r = check({ root, units: [out.check!], helpers: p.helpers, types: join(root, 'src/sinter.types.ts'), tsc });
    return { root, compile: out.diagnostics, ...r, at: r.diagnostics.map((d) => `${d.file.slice(root.length + 1)}:${d.line} ${d.message.replace(/\s+/g, ' ')}`) };
  }
  const posts = {
    'content/posts/hello.md': '---\ntitle: Hello\ndate: 2026-11-02\n---\nHi.\n',
    'content/posts/recap.md': '---\ntitle: Recap\ndate: 2026-12-30\ntags: [a]\n---\nThe year.\n',
  };

  test('a glob typed by one entry: the page reads it with the fields sinter adds, and every file fits', () => {
    const r = runFiles('<sn-resource name="posts" src="file:/content/posts/*.md" type="Post"></sn-resource><template data-sn-for="p in posts"><a data-sn-attr="{ href: p.slug + p.dir + p.path }" data-sn-text="p.title + p.body.length + (p.tags ?? []).length"></a></template>', posts);
    expect(r.compile).toEqual([]);
    expect(r.at).toEqual([]);
    expect(r.resources).toBe(1);
    expect(r.typed).toBe(1);
  });

  test('a typo in a page, and in a file\'s frontmatter, and a field a file leaves out: each an error where it is', () => {
    const page = runFiles('<sn-resource name="posts" src="file:/content/posts/*.md" type="Post"></sn-resource><template data-sn-for="p in posts"><a data-sn-text="p.titel"></a></template>', posts);
    expect(page.at).toEqual([expect.stringMatching(/^index\.html:1 Property 'titel' does not exist on type/)]);
    const files = runFiles('<sn-resource name="posts" src="file:/content/posts/*.md" type="Post"></sn-resource><p data-sn-text="posts.length"></p>', {
      ...posts,
      'content/posts/typo.md': '---\ntitel: Typo\ndate: 2026-01-01\n---\nx\n',
      'content/posts/nodate.md': '---\ntitle: No date\n---\nx\n',
    });
    expect(files.at).toEqual(expect.arrayContaining([
      expect.stringMatching(/^content\/posts\/typo\.md:1 .*'titel' does not exist.*Did you mean to write 'title'\?/),
      expect.stringMatching(/^content\/posts\/nodate\.md:1 .*Property 'date' is missing/),
    ]));
    expect(files.at).toHaveLength(2);
  });

  test('markdown without `type`: `body` and the file fields, and nothing else', () => {
    const r = runFiles('<sn-resource name="post" src="file:/content/posts/hello.md"></sn-resource><p data-sn-text="post.body.length + post.title"></p>', posts);
    expect(r.compile).toEqual([]);
    expect(r.at).toEqual([expect.stringMatching(/^index\.html:1 Property 'title' does not exist on type '\{ body: string; \}'/)]);
  });

  test('one JSON file with `items`: what `items` picks fits `type`', () => {
    const ok = runFiles('<sn-resource name="people" src="file:/team.json" items="people" type="{ name: string }[]"></sn-resource><p data-sn-text="people.length"></p>', { 'team.json': '{"people":[{"name":"A"}]}' });
    expect(ok.at).toEqual([]);
    const bad = runFiles('<sn-resource name="people" src="file:/team.json" items="people" type="{ name: string }[]"></sn-resource><p data-sn-text="people.length"></p>', { 'team.json': '{"people":[{"nmae":"A"}]}' });
    expect(bad.at).toEqual([expect.stringMatching(/^team\.json:1 .*'nmae'/)]);
  });

  test('a `data-sn-pages` entry is one item of its list: a typo through it is an error', () => {
    const page = (expr: string) => `<!doctype html><html data-sn-path="/blog/:slug" data-sn-pages="post in posts"><head></head><body><sn-resource name="posts" src="file:/content/posts/*.md" type="Post"></sn-resource><h1 data-sn-text="${expr}"></h1></body></html>`;
    expect(runFiles(page('post.title + post.slug + post.body.length'), posts).at).toEqual([]);
    expect(runFiles(page('post.titel'), posts).at).toEqual([expect.stringMatching(/^index\.html:1 Property 'titel' does not exist on type .*Did you mean 'title'\?/)]);
  });
});

describe('content: resources, typed from their loaders', () => {
  test('without `type`: what the loader returns; a typo is an error, and no SN504', () => {
    const files = {
      'src/sinter.content.ts': `import { collection } from '@tiaforge-ui/sinter/content';
export interface Product { sku: string; name: string; price: number }
export const products = collection<Product>({ key: 'sku', load: async () => [] as Product[] });
`,
      'node_modules/@tiaforge-ui/sinter/package.json': JSON.stringify({ name: '@tiaforge-ui/sinter', type: 'module', exports: { './content': './content.ts' } }),
      'node_modules/@tiaforge-ui/sinter/content.ts': readFileSync(join(import.meta.dirname, '../../src/content.ts'), 'utf8'),
    };
    const root = project(files);
    const p = projectOf(root);
    const run = (expr: string) => {
      const html = `<sn-resource name="products" src="content:products" fields="sku,name,price"></sn-resource><template data-sn-for="x in products"><b data-sn-text="${expr}"></b></template>`;
      writeFileSync(join(root, 'index.html'), html);
      const out = compile(html, { file: join(root, 'index.html'), root, dev: false, helpers: p.helpers, readFile: p.readFile, check: true, contentModule: p.contentFile!, collections: new Map([['products', { key: 'sku', value: [] }]]) });
      return { compile: out.diagnostics.map((d) => d.code), check: check({ root, units: [out.check!], helpers: p.helpers, types: null, tsc }).diagnostics.map((d) => d.message) };
    };
    expect(p.contentFile).toBe(join(root, 'src/sinter.content.ts'));
    expect(run('x.name + x.price.toFixed(2)')).toEqual({ compile: [], check: [] });
    expect(run('x.nmae').check).toEqual([expect.stringMatching(/Property 'nmae' does not exist on type 'Product'/)]);
  });
});


import { describe, expect, test } from 'vitest';
import { compile, compileParts, CODES, type ComplexityOptions } from '../../src/compiler/index.js';
import { complexityOf } from '../../src/project.js';

const files: Record<string, string> = {
  '/p/src/components/x-a.html': '<template data-sn-component=""><div><x-b></x-b></div></template>',
  '/p/src/components/x-b.html': '<template data-sn-component=""><div><x-a></x-a></div></template>',
  '/p/src/components/x-bad.html': '<template data-sn-component=""><p>\n  <b data-sn-txt="x"></b></p></template>',
  '/p/src/components/x-card.html': '<template data-sn-component="{ title: string }" data-sn-emits="{ pick: number }"><div><slot name="foot"></slot></div></template>',
  '/p/partials/old.html': '<p></p>',
  '/p/src/layouts/x-shell.html': '<!doctype html><html data-sn-layout=""><head></head><body><slot></slot></body></html>',
  '/p/src/components/x-two.html': '<template data-sn-component=""><p></p><p></p></template>',
};

const SPEC = { file: '/p/openapi.json', doc: {
  openapi: '3.0.3',
  paths: {
    '/api/c': { get: { parameters: [{ name: 'q', in: 'query' }], responses: { '200': { description: 'ok', content: { 'application/json': {
      schema: { type: 'object', properties: { contacts: { type: 'array', items: { $ref: '#/components/schemas/Contact' } }, total: { type: 'integer' } } } } } } } } },
    '/api/c/{id}/star': { post: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { contact: { $ref: '#/components/schemas/Contact' } } } } } } } } },
  },
  components: { schemas: { Contact: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, starred: { type: 'boolean' } } } } },
} };

interface Opts { check?: boolean; openapi?: boolean; complexity?: ComplexityOptions; checkCycles?: boolean }

function diags(html: string, o: Opts = {}) {
  return compile(html, {
    file: '/p/page.html', root: '/p', dev: false, check: o.check, openapi: o.openapi ? [SPEC] : undefined, complexity: o.complexity, checkCycles: o.checkCycles,
    readFile: (p) => { if (!(p in files)) throw new Error('missing'); return files[p]!; },
    helpers: { module: '/h.js', names: ['fmt'], namespaces: { m: { module: '/m.js', members: ['inbox_title'] } } },
  }).diagnostics;
}

const R = `<sn-resource name="contacts" src="/api/c" key="id"></sn-resource>
  <sn-resource name="messages" src="/api/m" key="uid" paginate="keyset" page-size="5" cursor="{uid}"></sn-resource>`;
const use = '<p data-sn-text="contacts.length + messages.length"></p>';

/** One failing fixture per diagnostic code; the message text is part of the public API. */
const cases: Array<[string, string, RegExp, Opts?]> = [
  ['SN101', '<p data-sn-txt="1"></p>', /`data-sn-txt` is not a sinter attribute. Did you mean `data-sn-text`\?/],
  ['SN102', '<div data-sn-for="x in [1]"></div>', /`data-sn-for` must be on a `<template>`/],
  ['SN103', '<template data-sn-for="x in [1, 2]"><i></i></template>', /needs `data-sn-key`/],
  ['SN103', '<sn-resource name="c" src="/api/c" items="contacts"></sn-resource><p data-sn-text="c"></p>', /`GET \/api\/c` returns a list at `contacts`: resource `c` needs `key`, the field that identifies an item/, { openapi: true }],
  ['SN104', '<div data-sn-state="{f: null}"><input type="file" data-sn-model="f"></div>', /does not support `type="file"`/],
  ['SN201', `${R}${use}<p data-sn-text="contcts.length"></p>`, /`contcts` is not defined here. Did you mean `contacts`\?/],
  ['SN202', '<p data-sn-text="window.x"></p>', /`window` is a browser API/],
  ['SN203', '<div data-sn-state="{a: 1}"><p data-sn-text="a = 2"></p></div>', /value expressions cannot assign; move this to `data-sn-on-\*`/],
  ['SN204', '<div data-sn-state="{a: 1}"><button data-sn-post="/x" data-sn-optimistic="a = 2"></button></div>', /may only call `patch`, `upsert`, `remove`/],
  ['SN205', `${R}${use}<template data-sn-for="m in messages"><button data-sn-on-click="m.is_read = true"></button></template>`, /`m.is_read` mutates a resource. Use `patch\(m, \{…\}\)`/],
  ['SN206', '<p data-sn-text="m.inbox_titel()"></p>', /`m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`\?/],
  ['SN207', '<a data-sn-attr="{onclick: 1}"></a>', /`onclick` cannot be bound with `data-sn-attr`; use `data-sn-on-click`/],
  ['SN209', '<div data-sn-state="{ s: 1 }" data-sn-let="{ s: 2 }"><p data-sn-text="s"></p></div>', /`s` is already defined here; use another name/],
  ['SN209', '<sn-resource name="remove" src="/api/r" key="id"></sn-resource><p data-sn-text="1"></p>', /`remove` is a store function \(`remove\(\)`\); a resource cannot take its name/],
  ['SN301', `${R}${use}<button data-sn-on-click="refresh('mesages')"></button>`, /resource `mesages` is not declared on this page/],
  ['SN302', `${R}${use}<sn-resource name="contacts" src="/x" key="id"></sn-resource>`, /resource `contacts` is declared twice/],
  ['SN303', `${R}${use}<p data-sn-text="$meta.contacts.loadng"></p>`, /`\$meta.contacts.loadng` is not a status field. Did you mean `loading`\?/],
  ['SN304', `${R}${use}<button data-sn-on-click="page('messages', 7)"></button>`, /keyset pagination cannot jump to a page number/],
  ['SN308', '<sn-resource name="c" src="/api/c" items="contcts"></sn-resource><p data-sn-text="c"></p>', /the response of `GET \/api\/c` has no `contcts`. Did you mean `contacts`\?/, { openapi: true }],
  ['SN306', '<x-a></x-a>', /`<x-a>` → `<x-b>` → `<x-a>` uses itself with no `data-sn-for` or `data-sn-if` template between/],
  ['SN309', '<dialog id="compose"></dialog><button data-sn-on-click="showModal(\'compse\')"></button>', /no `<dialog id="compse">` on this page. Did you mean `compose`\?/],
  ['SN310', '<button data-sn-call="archive(1)"></button>', /`archive` is not exported by the actions module/],
  ['SN311', `<span id="mark-read" data-sn-post="/x"></span><button data-sn-on-click="run('mark-raed')"></button>`, /no element `id="mark-raed"` on this page. Did you mean `mark-read`\?/],
  ['SN312', '<x-two></x-two>', /a component has one root element/],
  ['SN313', '<x-card data-sn-prop="{ titel: 1 }"></x-card>', /`titel` is not a prop of `<x-card>`/],
  ['SN314', '<x-card data-sn-prop="{ title: \'a\' }"><b slot="fot"></b></x-card>', /`<x-card>` has no slot `fot`/],
  ['SN315', '<x-card data-sn-prop="{ title: \'a\' }" data-sn-on-pik="1"></x-card>', /`<x-card>` does not emit `pik`/],
  ['SN316', '<sn-include src="./partials/old.html"></sn-include>', /`<sn-include>` is removed: a partial is a component/],
  ['SN317', `${R}${use}<template data-sn-for="m in messages"><button data-sn-on-click="remove('messages', m)"></button></template>`, /`remove\(\)` takes the item, not a resource name/],
  ['SN318', '<p data-sn-layout=""></p>', /`data-sn-layout` belongs on the `<html>` of a layout file/],
  ['SN319', '<p>x</p><x-shell></x-shell>', /a page that uses the layout `<x-shell>` is only its tag/],
  ['SN321', '<!doctype html><html><head><title>a</title><title>b</title></head><body></body></html>', /a second `<title>` in the head/],
  ['SN323', '<p data-sn-text="$site"></p>', /`\$site` is the site's root URL, and the build does not know the site's origin/],
  ['SN320', '<!doctype html><html><head><title>t</title><div></div></head><body></body></html>', /`<div>` cannot be in the `<head>`/],
  ['SN401', '<p data-sn-text="a +"></p>', /Unexpected token/],
  ['SN501', R + '<p data-sn-text="messages.length"></p>', /resource `contacts` is declared but never read/],
  ['SN502', '<p data-sn-text="Date.now()"></p>', /`Date.now\(\)` in a binding never updates. Use `\$now`/],
  ['SN503', `${R}${use}<template data-sn-for="c in contacts"><a data-sn-attr="{id: c.id}"></a></template>`, /`id` bound from data can shadow globals/],
  ['SN504', `${R}${use}`, /resource `contacts` has no type: expressions using it are not checked/, { check: true }],
  ['SN506', `${R}${use}<sn-sync src="/api/events"><sn-event name="contact_updated" resource="contacts" op="upsert" item="contact"></sn-event></sn-sync>`, /event `contact_updated` has no type: expressions reading its payload are not checked/, { check: true }],
  ['SN507', '<div data-sn-state="{ a: 0 }"><button data-sn-on-click="a = 1; a = 2; a = 3; a = 4; a = 5" data-sn-text="a"></button></div>', /`data-sn-on-click` is too complex for markup: 5 statements in one handler \(limit `statements`: 4\)\. Move the logic into a helper/],
  ['SN509', `<button id="save" data-sn-post="/x" data-sn-catch="run('save')"></button>`, /`run\(\)` cycle: `#save` `data-sn-catch` \(page.html:1\) runs `#save`, which starts the first step again/, { checkCycles: true }],
  ['SN513', '<div data-sn-state="{ dark: false }"><img alt="" data-sn-attr="{src: dark ? \'./logo-dark.png\' : \'./logo.png\'}"></div>', /`src` is bound to local images \(`\.\/logo-dark\.png`, `\.\/logo\.png`\), which are not optimized/],
  ['SN516', '<sn-resource name="c" src="/api/c" items="contacts"></sn-resource><p data-sn-text="$meta.c.live"></p>', /`\$meta\.c\.live` is always `null`: no `<sn-event resource="c">` on this page feeds `c`/],
  ['SN515', '<!doctype html><html data-sn-path="/page/"><head></head><body></body></html>', /`data-sn-path="\/page\/"` is the URL this page has anyway/],
  ['SN326', '<sn-resource name="c" operation="GET /api/cc" items="contacts"></sn-resource><p data-sn-text="c"></p>', /the OpenAPI spec has no operation `GET \/api\/cc`. Did you mean `GET \/api\/c`\?/, { openapi: true }],
  ['SN327', '<sn-resource name="c" operation="GET /api/c" params="{ qq: 1 }" items="contacts"></sn-resource><p data-sn-text="c"></p>', /`GET \/api\/c` has no parameter `qq`. Did you mean `q`\?/, { openapi: true }],
  ['SN505', '<sn-resource name="c" src="/api/c?qq=1" items="contacts"></sn-resource><p data-sn-text="c"></p>', /`GET \/api\/c` declares no query parameter `qq`. Did you mean `q`\?/, { openapi: true }],
  ['SN510', `<sn-resource name="c" src="/api/c" items="contacts" key="id"></sn-resource><template data-sn-for="x in c"><button data-sn-post="/api/c/{x.id}/star" data-sn-then="patch(x, $result.contact)"></button></template>`,
    /`patch\(x, \$result\.contact\)` is what write-through does: the response of `POST \/api\/c\/\{id\}\/star` is `Contact`, which `c` holds; remove this write, or add `data-sn-apply="off"` to keep it/, { openapi: true }],
];

/** Codes that do not come from compile(): `sinter check` runs TypeScript (SN208), loading a spec fails (SN307). Fixtures in test/check. */
const CHECK_ONLY = ['SN208', 'SN307'];
/** Codes that need an image host (the adapter's file analysis). Fixtures in test/compiler/images.test.ts. */
const IMAGES_ONLY = ['SN511', 'SN512', 'SN514'];
/** Codes for pages listed in `sinter({ static })`. Fixtures in test/compiler/static.test.ts. */
const STATIC_ONLY = ['SN322'];
/** Lazy packages (`sinter({ lazy })`): the app's modules and the build. Fixtures in test/lazy.test.ts and test/vite/lazy.test.ts. */
const LAZY_ONLY = ['SN324', 'SN325'];

describe('every diagnostic code has a failing fixture', () => {
  test('all codes covered', () => {
    expect(new Set([...cases.map((c) => c[0]), ...CHECK_ONLY, ...IMAGES_ONLY, ...STATIC_ONLY, ...LAZY_ONLY])).toEqual(new Set(Object.keys(CODES)));
  });
  for (const [code, html, message, check] of cases) {
    test(code, () => {
      const d = diags(html, check).find((x) => x.code === code);
      expect(d, JSON.stringify(diags(html, check), null, 2)).toBeDefined();
      expect(d!.message).toMatch(message);
      expect(d!.severity).toBe(code >= 'SN500' ? 'warning' : 'error');
    });
  }
});

test('SN503 passes a value with a literal prefix', () => {
  const sn503 = (v: string) => diags(`${R}${use}<template data-sn-for="c in contacts"><a data-sn-attr="{${v}}"></a></template>`).filter((d) => d.code === 'SN503').length;
  expect(sn503("id: 'contact-' + c.id")).toBe(0);
  expect(sn503("name: 'c-' + c.id + '-x'")).toBe(0);
  expect(sn503('id: `contact-${c.id}`')).toBe(0);
  expect(sn503("id: c.id + '-x'")).toBe(1);
  expect(sn503("id: '' + c.id")).toBe(1);
  expect(sn503('id: `${c.id}-x`')).toBe(1);
});

describe('sandbox gaps closed', () => {
  const codes = (html: string) => diags(html).filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
  test('a literal origin followed by a value needs its `/`', () => {
    expect(codes('<div data-sn-state="{x: 1}"><button data-sn-get="https://api.example.com{x}/p"></button></div>')).toEqual([expect.stringMatching(/^SN207 a URL template must start/)]);
    expect(codes('<div data-sn-state="{x: 1}"><button data-sn-get="https://api.example.com/{x}"></button></div>')).toEqual([]);
    expect(codes('<button data-sn-get="https://api.example.com"></button>')).toEqual([]);
  });
  test('Object.assign() on a resource item is a mutation; on state it is a write', () => {
    expect(codes(`${R}${use}<template data-sn-for="c in contacts"><button data-sn-on-click="Object.assign(c, {name: 'x'})"></button></template>`))
      .toEqual([expect.stringMatching(/^SN205 `Object.assign\(c, …\)` mutates a resource/)]);
    expect(codes('<div data-sn-state="{d: {a: 1}}"><p data-sn-text="Object.assign(d, {a: 2})"></p></div>'))
      .toEqual([expect.stringMatching(/^SN203 value expressions cannot change state; move `Object.assign\(\)`/)]);
    expect(codes('<div data-sn-state="{d: {a: 1}}"><button data-sn-on-click="Object.assign(d, {a: 2})"></button><p data-sn-text="d.a"></p></div>')).toEqual([]);
  });
  test('forbidden keys cannot be named as Object.* arguments', () => {
    expect(codes(`<p data-sn-text="Object.getOwnPropertyDescriptor(Object.getPrototypeOf(x => x), 'constructor').value"></p>`))
      .toEqual([expect.stringMatching(/^SN207 `'constructor'` is not allowed as an argument of `Object.getOwnPropertyDescriptor\(\)`/)]);
  });
});

test('refresh() with several names: each is a literal, declared resource', () => {
  const msgs = (h: string) => diags(`${R}${use}${h}`).map((d) => `${d.code} ${d.message}`);
  expect(msgs(`<button data-sn-on-click="refresh('contacts', 'messages')"></button>`)).toEqual([]);
  expect(msgs(`<button data-sn-on-click="refresh('contacts', 'mesages')"></button>`)).toEqual(['SN301 resource `mesages` is not declared on this page. Did you mean `messages`?']);
  expect(msgs(`<div data-sn-state="{ r: 'contacts' }"><button data-sn-on-click="refresh('contacts', r)"></button></div>`)).toEqual([`SN301 ${FORMS('refresh')}`]);
  expect(msgs(`<button data-sn-on-click="refresh()"></button>`)).toEqual([`SN301 ${FORMS('refresh')}`]);
});

const FORMS = (fn: string) => `\`${fn}()\` takes ${fn === 'refresh' ? 'resource names' : 'a resource name'}: a string literal, \`?:\`, \`||\` or \`??\` between them, or a \`data-sn-let\` name that is one`;

describe('resource names from a closed set of literals', () => {
  const P = `<sn-resource name="messages" src="/api/m" key="uid" paginate="keyset" page-size="5" cursor="{uid}"></sn-resource>
  <sn-resource name="results" src="/api/r" key="uid" paginate="offset" page-size="5"></sn-resource>
  <sn-resource name="jumps" src="/api/j" key="uid" paginate="keyset" page-size="5" cursor="{uid}" offset-param="offset"></sn-resource>
  <sn-resource name="feed" src="/api/f" key="uid" paginate="append" page-size="5" cursor="{uid}"></sn-resource>
  <sn-resource name="other" src="/api/o" key="id"></sn-resource>`;
  const msgs = (h: string, o: Opts = {}) => diags(`${P}<main data-sn-state="{ s: false, tab: 'messages' }">${h}</main>`, o).map((d) => `${d.code} ${d.message}`);
  const on = (h: string, lets = `{ shown: s ? 'results' : 'messages' }`) => msgs(`<div data-sn-let="${lets}"><button data-sn-on-click="${h}"></button></div>`).filter((m) => !m.startsWith('SN501'));

  test('?:, ||, ?? and lets: every name is checked like a literal, and counts as used', () => {
    expect(msgs(`<div data-sn-let="{ shown: s ? 'results' : 'messages', list: s ? results : messages }"><p data-sn-text="list.length"></p>
      <button data-sn-on-click="page(shown, 'next'); refresh(shown, s ? 'jumps' : 'feed'); upsert(shown, $event.detail)"></button>
      <button data-sn-on-click="upsert((s ? 'other' : 'messages') || 'other', 1); upsert((s ? 'messages' : 'jumps') ?? 'feed', 1)"></button></div>`)).toEqual([]);
    expect(on(`page(s ? 'reslts' : 'messages', 'next')`)).toEqual(expect.arrayContaining(['SN301 resource `reslts` is not declared on this page. Did you mean `results`?']));
    // a let's names: an unknown one is reported where the let is read
    expect(on(`refresh(shown)`, `{ shown: s ? 'mesages' : 'results' }`).filter((m) => m.startsWith('SN301'))).toEqual(['SN301 resource `mesages` is not declared on this page. Did you mean `messages`?']);
    // lets built from lets
    expect(on(`page(both, 'next')`, `{ a: 'results', both: s ? a : 'messages' }`)).toEqual([]);
  });

  test('names that cannot be listed stay SN301, with the forms allowed', () => {
    expect(on(`page(tab, 'next')`)).toEqual([`SN301 ${FORMS('page')}`]);
    expect(on(`refresh(s && 'messages')`)).toEqual([`SN301 ${FORMS('refresh')}`]);
    expect(on(`upsert($event.detail, 1)`)).toEqual([`SN301 ${FORMS('upsert')}`]);
    expect(on(`upsert(s ? tab : 'messages', 1)`)).toEqual([`SN301 ${FORMS('upsert')}`]);
    expect(on(`upsert(String('messages'), 1)`)).toEqual([`SN301 ${FORMS('upsert')}`]);
  });

  test('page(): SN303 and SN304 for each name it can take', () => {
    expect(on(`page(s ? 'other' : 'messages', 'next')`)).toEqual(['SN303 `other` has no `paginate`; `page()` needs a paginated resource']);
    // a page number: fine where every name can jump, SN304 where one is keyset without offset-param
    expect(on(`page(s ? 'results' : 'jumps', 3)`)).toEqual([]);
    expect(on(`page(shown, 3)`)).toEqual(['SN304 keyset pagination cannot jump to a page number. Add `offset-param` if the server also accepts an offset, or use `paginate="offset"`']);
    expect(on(`page(s ? 'feed' : 'messages', 'prev')`)).toEqual(['SN304 `append` pagination only supports `page(…, \'next\')`']);
    expect(on(`page(s ? 'feed' : 'messages', 'next')`)).toEqual([]);
  });

  test('computed $meta keys: checked for each name when they can be listed, otherwise accepted', () => {
    const text = (x: string, lets?: string) => msgs(`<div data-sn-let="${lets ?? `{ shown: s ? 'results' : 'messages' }`}"><p data-sn-text="${x}"></p></div>`).filter((m) => !m.startsWith('SN501'));
    expect(text(`$meta[shown].hasNext`)).toEqual([]);
    expect(text(`$meta[shown].hasNxt`)).toEqual([
      'SN303 `$meta.results.hasNxt` is not a status field. Did you mean `hasNext`?',
      'SN303 `$meta.messages.hasNxt` is not a status field. Did you mean `hasNext`?',
    ]);
    expect(text(`$meta[s ? 'reslts' : 'messages'].loading`)).toEqual(['SN301 resource `reslts` is not declared on this page. Did you mean `results`?']);
    expect(text(`$meta[s ? 'other' : 'results'].page`)).toEqual(['SN303 `$meta.other.page` is a pagination field, but `other` has no `paginate`']);
    expect(text(`$meta[s ? 'jumps' : 'messages'].page`)).toEqual(['SN303 `$meta.messages.page` exists only with `paginate="offset"`, or `paginate="keyset"` with `offset-param`']);
    // other computed keys: accepted, unchecked
    expect(text(`$meta[tab].hasNxt`)).toEqual([]);
  });

  test('dependencies: a listable $meta key reads only those resources\' status', () => {
    const r = compileParts(`${P}<main data-sn-state="{ s: false, tab: 'x' }" data-sn-let="{ shown: s ? 'results' : 'messages' }"><p data-sn-text="$meta[shown].hasNext"></p><p data-sn-text="$meta[tab].loading"></p><p data-sn-text="results.length + messages.length + jumps.length + feed.length + other.length"></p></main>`, {
      file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: '/h.js', names: [], namespaces: {} },
    });
    expect(r.diagnostics).toEqual([]);
    // the compiler's IR keeps the paths as strings (the page module numbers them)
    const deps = r.ir.roots.flatMap((n) => n.b.flatMap((b) => (b.d ?? []) as string[])).filter((d) => d.startsWith('$meta'));
    expect(deps).toEqual(expect.arrayContaining(['$meta.results.hasNext', '$meta.messages.hasNext', '$meta']));
    expect(deps).not.toContain('$meta.other.hasNext');
  });

  test('SN501: a resource only named through a store call or a listable $meta key is used', () => {
    const unused = (h: string) => diags(`<sn-resource name="a" src="/a" key="id"></sn-resource><sn-resource name="b" src="/b" key="id"></sn-resource>
      <div data-sn-state="{ s: false }">${h}</div>`).filter((d) => d.code === 'SN501').map((d) => d.message);
    expect(unused(`<button data-sn-on-click="refresh(s ? 'a' : 'b')"></button>`)).toEqual([]);
    expect(unused(`<p data-sn-text="$meta[s ? 'a' : 'b'].loading"></p>`)).toEqual([]);
    expect(unused(`<button data-sn-on-click="refresh('a')"></button>`)).toEqual(['resource `b` is declared but never read']);
  });

  test('SN509: refresh() through a let adds an edge for each name', () => {
    const html = `<sn-resource name="a" src="/a" key="id" then="run('go')"></sn-resource><sn-resource name="b" src="/b" key="id"></sn-resource>
      <div data-sn-state="{ s: false }" data-sn-let="{ which: s ? 'b' : 'a' }"><span id="go" data-sn-post="/x" data-sn-then="refresh(which)"></span><p data-sn-text="b.length"></p></div>`;
    expect(diags(html, { checkCycles: true }).filter((d) => d.code === 'SN509').map((d) => d.message)).toEqual([expect.stringMatching(/cycle/)]);
  });
});

describe('<sn-event then>', () => {
  const codes = (events: string) => diags(`${R}${use}<dialog id="detail"></dialog><main data-sn-state="{ sel: null }"><p data-sn-text="sel"></p>
    <sn-sync src="/api/events">${events}</sn-sync></main>`).filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
  test('a handler: state writes, store functions and payload fields; with `then`, resource and op may be left out', () => {
    expect(codes(`<sn-event name="r" resource="contacts" op="remove" then="sel?.id === id && (sel = null, close('detail')); refresh('messages')"></sn-event>`)).toEqual([]);
    expect(codes(`<sn-event name="n" then="sel = id"></sn-event>`)).toEqual([]);
    expect(codes(`<sn-event name="n" when="id = 1"></sn-event>`)).toEqual([expect.stringMatching(/^SN301 resource `` is not declared/)]);
  });
  test('data-sn-let names around the sync resolve like state, before payload fields; they cannot be assigned', () => {
    const lets = (events: string) => diags(`${R}${use}<main data-sn-state="{ sel: null }" data-sn-let="{ open: sel, tag: $el.id }"><p data-sn-text="open + tag"></p>
      <sn-sync src="/api/events">${events}</sn-sync></main>`).filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
    expect(lets(`<sn-event name="n" when="open && open.id === id" then="open && sel === open && refresh('messages')"></sn-event>`)).toEqual([]);
    expect(lets(`<sn-event name="n" then="open = id"></sn-event>`)).toEqual(['SN203 `open` is derived (`data-sn-let`) and cannot be assigned; assign the state it is computed from']);
    expect(lets(`<sn-event name="n" then="sel = tag"></sn-event>`)).toEqual(['SN201 `tag` (`data-sn-let`) reads `$el`, and `<sn-event>` has no element']);
    const parts = compileParts(`${R}${use}<main data-sn-state="{ sel: null }" data-sn-let="{ open: sel }"><p data-sn-text="open"></p>
      <sn-sync src="/api/events"><sn-event name="n" then="sel = open || id"></sn-event></sn-sync></main>`, {
      file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
    });
    expect(parts.fns.find((f) => f.includes('$.$p.id'))).toContain('$.$s0.sel || $.$p.id');
  });
  test('errors: unknown dialogs, element-less store functions, payload writes, a misspelt attribute', () => {
    expect(codes(`<sn-event name="n" then="close('detial')"></sn-event>`)).toEqual([expect.stringMatching(/^SN309 no `<dialog id="detial">` on this page. Did you mean `detail`\?/)]);
    expect(codes(`<sn-event name="n" then="close(); reset(); emit('x')"></sn-event>`)).toEqual([
      "SN203 `close()` needs an element; an `<sn-event>` handler has none: name the dialog, `close('id')`",
      'SN203 `reset()` needs an element; an `<sn-event>` handler has none',
      'SN203 `emit()` needs an element; an `<sn-event>` handler has none',
    ]);
    expect(codes(`<sn-event name="n" then="id = 2"></sn-event>`)).toEqual([expect.stringMatching(/^SN203 `id` cannot be assigned/)]);
    expect(codes(`<sn-event name="n" then="$event.x"></sn-event>`)).toEqual([expect.stringMatching(/^SN201 `\$event` is not available here/)]);
    expect(codes(`<sn-event name="r" resource="contacts" op="remove" thn="sel = null"></sn-event>`))
      .toEqual(['SN101 `thn` is not an attribute of `<sn-event>`. Did you mean `then`?']);
  });
});

describe('data-sn-attr with data-sn-model', () => {
  const codes = (html: string) => diags(`<div data-sn-state="{ v: '', on: false, list: [] }">${html}</div>`).filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
  test('the state the model writes cannot also be bound', () => {
    expect(codes(`<input data-sn-model="v" data-sn-attr="{value: v}">`))
      .toEqual(["SN102 `value` is the control state `data-sn-model` writes; set it through the model's state, not `data-sn-attr`"]);
    expect(codes(`<input type="checkbox" data-sn-model="on" data-sn-attr="{checked: on}">`))
      .toEqual(["SN102 `checked` is the control state `data-sn-model` writes; set it through the model's state, not `data-sn-attr`"]);
  });
  test('a checkbox list binds `value` (what the model collects) and `indeterminate`', () => {
    expect(codes(`<input type="checkbox" data-sn-model="list" data-sn-attr="{value: 'a', indeterminate: !list.length}">`)).toEqual([]);
  });
});

describe('<sn-resource then>', () => {
  const codes = (then: string, attrs = '') => diags(`<dialog id="detail"></dialog><main data-sn-state="{ sel: null }"><p data-sn-text="sel + c.length"></p>
    <sn-resource name="c" src="/api/c" key="id" ${attrs} then="${then}"></sn-resource></main>`).filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
  test('a handler: $result, state writes, store functions and resources', () => {
    expect(codes("sel = $result[0]; c.length && showModal('detail'); close('detail'); refresh('c')")).toEqual([]);
  });
  test('errors: element-less store functions, $event, value-only places, a misspelt attribute', () => {
    expect(codes("close(); reset(); emit('x')")).toEqual([
      "SN203 `close()` needs an element; an `<sn-resource>` handler has none: name the dialog, `close('id')`",
      'SN203 `reset()` needs an element; an `<sn-resource>` handler has none',
      'SN203 `emit()` needs an element; an `<sn-resource>` handler has none',
    ]);
    expect(codes('$event.x')).toEqual([expect.stringMatching(/^SN201 `\$event` is not available here/)]);
    expect(codes('$error')).toEqual([expect.stringMatching(/^SN201 `\$error` is not available here/)]);
    expect(codes("showModal('detial')")).toEqual([expect.stringMatching(/^SN309 no `<dialog id="detial">` on this page/)]);
    expect(codes('let x = 1')).toEqual([expect.stringMatching(/^SN203 handlers cannot contain declarations/)]);
    expect(diags('<sn-resource name="c" src="/api/c" key="id" thn="x"></sn-resource><p data-sn-text="c.length"></p>').map((d) => `${d.code} ${d.message}`))
      .toEqual(['SN101 `thn` is not an attribute of `<sn-resource>`. Did you mean `then`?']);
  });
  test('a resource with `then` is used (SN501), whether or not the handler reads `$result`', () => {
    // the spec's pattern: a resource loaded only for its `then`
    const sn501 = (then: string) => diags(`<dialog id="mail-compose"></dialog><main data-sn-state="{ compose: null, seen: false }">
      <sn-resource name="pending" src="/api/pending" then="${then}"></sn-resource><p data-sn-text="compose"></p></main>`).filter((d) => d.code === 'SN501');
    expect(sn501("compose = $result ?? compose; $result && showModal('mail-compose')")).toEqual([]);
    expect(sn501('seen = true')).toEqual([]);
    expect(diags('<sn-resource name="pending" src="/api/pending"></sn-resource><p data-sn-text="1"></p>').map((d) => d.code)).toEqual(['SN501']);
  });
  test('$result is only for `then`: other resource expressions refuse it', () => {
    expect(codes('', 'when="$result"').filter((c) => !c.startsWith('SN401'))).toEqual([expect.stringMatching(/^SN201 `\$result` is not available here/)]);
  });
});

describe('positions', () => {
  test('point into the attribute value', () => {
    const d = diags('<div>\n  <p data-sn-text="1 + contcts"></p>\n</div>')[0]!;
    expect([d.line, d.col]).toEqual([2, 24]);
  });
  test('point into the component, followed by where it is used', () => {
    const d = diags('<div>\n<x-bad></x-bad></div>')[0]!;
    expect(d.file).toBe('/p/src/components/x-bad.html');
    expect(d.line).toBe(2);
    expect(d.message).toContain('included from page.html:2');
  });
});

describe('SN207 unsafe sinks', () => {
  const sinks: Array<[string, RegExp]> = [
    ['<a data-sn-attr="{[k]: 1}"></a>', /keys must be literal/],
    ['<div data-sn-state="{o: {}}"><a data-sn-attr="{...o}"></a></div>', /spread/],
    ['<a data-sn-attr="{style: 1}"></a>', /use `data-sn-style`/],
    ['<iframe data-sn-attr="{srcdoc: 1}"></iframe>', /cannot carry sinter bindings/],
    ['<div data-sn-attr="{srcdoc: 1}"></div>', /`srcdoc` cannot be bound/],
    ['<x-el data-sn-prop="{innerHTML: 1}"></x-el>', /`innerHTML` cannot be set/],
    ['<div data-sn-style="{[k]: 1}"></div>', /keys must be literal/],
    ['<script data-sn-text="1"></script>', /cannot carry sinter bindings/],
    ['<svg><animate data-sn-attr="{to: 1}"></animate></svg>', /cannot carry sinter bindings/],
    ['<button data-sn-post="{u}/x"></button>', /must start with a literal same-origin path/],
    ['<button data-sn-post="//evil.example/x"></button>', /must start with a literal same-origin path/],
    ['<input type="password" data-sn-state="{p: 1}" data-sn-model="p" data-sn-persist="p">', /refused on password/],
    ['<div data-sn-state="{c: 1}"><input autocomplete="cc-number" data-sn-model="c" data-sn-persist="c"></div>', /refused on password/],
    ['<p data-sn-text="x.constructor"></p>', /`\.constructor` is not allowed|not defined/],
  ];
  for (const [html, msg] of sinks) {
    test(html, () => {
      const all = diags(html);
      expect(all.some((d) => msg.test(d.message)), JSON.stringify(all, null, 2)).toBe(true);
    });
  }
});

describe('data-sn-path', () => {
  test('path parameters are read-only', () => {
    const d = diags('<html data-sn-path="/article/:slug"><body><button data-sn-on-click="$url.slug = 1; $url.page = 2"></button></body></html>');
    expect(d.map((x) => x.code)).toEqual(['SN203']);
    expect(d[0]!.message).toMatch(/`\$url.slug` is a path parameter/);
  });
  test('belongs on <html> and takes patterns', () => {
    expect(diags('<div data-sn-path="/a"></div>')[0]!.code).toBe('SN102');
    expect(diags('<html data-sn-path="article/:slug /a/:__proto__ //x"></html>').map((x) => x.code)).toEqual(['SN401', 'SN401', 'SN401']);
  });
});

describe('expressions', () => {
  test('parenthesized expressions parse to their closing parenthesis', () => {
    expect(diags('<div data-sn-state="{xs: [], b: 1}"><template data-sn-for="a in (b ? xs : [])" data-sn-key="a"><i data-sn-text="(a)"></i></template></div>')).toEqual([]);
    expect(diags('<p data-sn-text="(1) )"></p>')[0]!.code).toBe('SN401');
  });
  test('globals: JavaScript yes, browser no; meta tools refused', () => {
    expect(diags('<p data-sn-text="Math.max(1, new Date(0).getTime(), JSON.stringify([]).length)"></p>')).toEqual([]);
    expect(diags('<p data-sn-text="fetch(1)"></p>')[0]!.code).toBe('SN202');
    expect(diags('<p data-sn-text="eval(1)"></p>')[0]!.code).toBe('SN202');
    expect(diags('<p data-sn-text="Reflect.ownKeys({})"></p>')[0]!.code).toBe('SN202');
  });
  test('handlers refuse declarations and loops', () => {
    expect(diags('<button data-sn-on-click="let a = 1"></button>')[0]!.code).toBe('SN203');
    expect(diags('<button data-sn-on-click="for (;;) {}"></button>')[0]!.code).toBe('SN203');
  });
  test('assignment only to state, $url params and $locale', () => {
    expect(diags('<button data-sn-on-click="$url.tab = 1; $locale = \'de\'"></button>')).toEqual([]);
    expect(diags('<button data-sn-on-click="Math.x = 1"></button>')[0]!.code).toBe('SN203');
  });
  test('magic names are only available where documented', () => {
    expect(diags('<p data-sn-text="$result"></p>')[0]!.message).toMatch(/not available here/);
    expect(diags('<button data-sn-post="/x" data-sn-then="$result"></button>')).toEqual([]);
  });
  test('resource mutators are SN205 with the patch() hint', () => {
    const d = diags(`${R}${use}<button data-sn-on-click="contacts.push(1)"></button>`);
    expect(d.find((x) => x.code === 'SN205')).toBeDefined();
  });
});

test('output is byte-identical for the same input', () => {
  const html = `${R}${use}<div data-sn-state="{q: ''}"><input data-sn-model="q"></div>`;
  const opts = { file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } };
  expect(compile(html, opts)).toEqual(compile(html, opts));
});

test('a data-sn-let name cannot be assigned or shadowed', () => {
  const ds = (html: string) => compile(html, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => { throw new Error('missing'); },
    helpers: { module: '/h.js', names: [], namespaces: {} },
  }).diagnostics.map((d) => d.message);
  expect(ds('<div data-sn-state="{ a: 1 }" data-sn-let="{ b: a + 1 }"><button data-sn-on-click="b = 3"></button></div>'))
    .toEqual([expect.stringMatching(/`b` is derived \(`data-sn-let`\) and cannot be assigned/)]);
  expect(ds('<div data-sn-let="{ b: 1 }"><template data-sn-for="b in [1]" data-sn-key="b"><i></i></template></div>'))
    .toEqual([expect.stringMatching(/`b` is already defined here by `data-sn-let`/)]);
});

test('data-sn-debounce-<event> needs that handler and milliseconds', () => {
  const ds = (html: string) => compile(html, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => { throw new Error('missing'); },
    helpers: { module: '/h.js', names: [], namespaces: {} },
  }).diagnostics.map((d) => `${d.code} ${d.message}`);
  expect(ds('<div data-sn-state="{ a: 0 }"><input data-sn-debounce-input="200" data-sn-on-change="a++"></div>'))
    .toEqual(['SN102 `data-sn-debounce-input` needs a `data-sn-on-input` handler on the same element']);
  expect(ds('<div data-sn-state="{ a: 0 }"><input data-sn-debounce-input="soon" data-sn-on-input="a++"></div>'))
    .toEqual(['SN401 `data-sn-debounce-input` takes milliseconds']);
});

describe('key filters', () => {
  const codes = (attrs: string) => diags(`<main data-sn-state="{ n: 0 }" ${attrs}><p data-sn-text="n"></p></main>`).map((d) => `${d.code} ${d.message}`);
  test('valid filters compile without diagnostics', () => {
    expect(codes(`data-sn-on-keydown-j="n++" data-sn-on-keydown-shift-n="n++" data-sn-on-keydown-ctrl-space="n++" data-sn-on-keydown-escape="n++"
      data-sn-on-keydown-mod-shift-enter="n++" data-sn-on-keyup-question="n++" data-sn-on-keydown-f5="n++" data-sn-on-keydown-1="n++"
      data-sn-on-keydown-alt-arrowdown="n++" data-sn-on-keydown-slash="n++" data-sn-debounce-keydown-j="100"`)).toEqual([]);
  });
  test('unknown key names and modifiers, with did-you-mean', () => {
    expect(codes('data-sn-on-keydown-esc="n++"')).toEqual(['SN101 `esc` in `data-sn-on-keydown-esc` is not a key name. Did you mean `escape`?']);
    expect(codes('data-sn-on-keydown-arowdown="n++"')).toEqual(['SN101 `arowdown` in `data-sn-on-keydown-arowdown` is not a key name. Did you mean `arrowdown`?']);
    expect(codes('data-sn-on-keydown-ctl-k="n++"')).toEqual(['SN101 `ctl` in `data-sn-on-keydown-ctl-k` is not a modifier. Did you mean `ctrl`?']);
    expect(codes('data-sn-on-keydown-cmd-k="n++"')).toEqual(['SN101 `cmd` in `data-sn-on-keydown-cmd-k` is not a modifier. Did you mean `meta`?']);
    expect(codes('data-sn-on-keydown-?="n++"')).toEqual(['SN101 `?` in `data-sn-on-keydown-?` is not a key name. Did you mean `question`?']);
  });
  test('the shape: one key, last; modifiers once; mod alone', () => {
    expect(codes('data-sn-on-keydown-shift="n++"')).toEqual(['SN101 `shift` is a modifier: a key filter ends with the key, e.g. `data-sn-on-keydown-shift-k`']);
    expect(codes('data-sn-on-keydown-j-k="n++"')).toEqual([expect.stringMatching(/^SN101 a key filter names one key, last: `j` in `data-sn-on-keydown-j-k` is a key/)]);
    expect(codes('data-sn-on-keydown-shift-shift-k="n++"')).toEqual(['SN101 `shift` appears twice in `data-sn-on-keydown-shift-shift-k`']);
    expect(codes('data-sn-on-keydown-mod-ctrl-k="n++"')).toEqual([expect.stringMatching(/^SN101 `mod` is Ctrl, or Cmd on Apple platforms/)]);
    expect(codes('data-sn-on-keydown-="n++"')).toEqual([expect.stringMatching(/^SN101 `data-sn-on-keydown-` is a key filter/)]);
  });
  test('uppercase in the source: HTML would lowercase it', () => {
    expect(codes('data-sn-on-keydown-N="n++"')).toEqual(['SN101 HTML lowercases attribute names, so `data-sn-on-keydown-N` would be `data-sn-on-keydown-n`: write N as `shift-n`']);
    expect(codes('data-sn-on-keydown-ctrl-K="n++"')).toEqual(['SN101 HTML lowercases attribute names, so `data-sn-on-keydown-ctrl-K` would be `data-sn-on-keydown-ctrl-k`: write K as `ctrl-shift-k`']);
    expect(codes('data-sn-on-keydown-Escape="n++"')).toEqual(['SN101 HTML lowercases attribute names: write `data-sn-on-keydown-Escape` as `data-sn-on-keydown-escape`']);
  });
  test('a key filter debounce needs its handler', () => {
    expect(codes('data-sn-on-keydown-j="n++" data-sn-debounce-keydown-k="10"')).toEqual(['SN102 `data-sn-debounce-keydown-k` needs a `data-sn-on-keydown-k` handler on the same element']);
  });
  test('the IR: event, key and modifier bits; the keys feature is loaded', () => {
    const r = compileParts('<main data-sn-state="{ n: 0 }" data-sn-on-keydown-mod-shift-enter="n++" data-sn-on-keyup-question="n++" data-sn-on-keydown-j="n++"><p data-sn-text="n"></p></main>', {
      file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
    });
    const on = r.ir.roots.flatMap((n) => n.b).filter((b) => b.k === 'on').map(({ n, q, m }) => ({ n, q, m }));
    expect(on).toEqual([{ n: 'keydown', q: 'Enter', m: 20 }, { n: 'keyup', q: '?', m: 32 }, { n: 'keydown', q: 'j', m: undefined }]);
    expect(r.features).toContain('keys');
  });
});

describe('SN507 complex expressions', () => {
  const page = (body: string) => `<sn-resource name="people" src="/api/p" key="id"></sn-resource>
    <main data-sn-state="{ q: '', sel: null, n: 0, list: [], open: false, d: { tags: [] } }"><p data-sn-text="people.length + q + sel + n + list + open + d"></p>${body}</main>`;
  const warned = (body: string, o: Opts = {}) => diags(page(body), o).filter((d) => d.code === 'SN507').map((d) => d.message.replace(/ Move the logic.*/, ''));

  test('idiomatic expressions are left alone', () => {
    for (const body of [
      `<template data-sn-for="p in people.filter(p => p.name.toLowerCase().includes(q.toLowerCase()))"><li data-sn-on-click="sel = p; showModal('person')" data-sn-text="p.name"></li></template>`,
      `<dialog id="person" data-sn-on-close="sel = null"></dialog><button data-sn-on-click="open && close('person')"></button>`,
      `<button data-sn-on-click="sel = fmt(sel, n)"></button><button data-sn-on-click="n++; open = !open; sel = null; refresh('people')"></button>`,
      `<p data-sn-class="{active: sel === q, muted: !open, big: n > 10 && !open}" data-sn-attr="{title: n ? fmt(n) : null, 'aria-pressed': open ? 'true' : 'false'}"></p>`,
      `<p data-sn-text="n === 0 ? 'none' : n === 1 ? 'one' : 'many'"></p>`,
      `<p data-sn-text="people.find(p => p.id === sel?.id && p.name !== q)?.name ?? ''"></p>`,
      `<template data-sn-for="c in people.filter(c => !q || (c.fn_name + ' ' + c.org).toLowerCase().includes(q.toLowerCase()))"><i></i></template>`,
      `<button data-sn-on-click="open ? close('person') : showModal('person')"></button>`,
      `<div data-sn-state="{ draft: { name: '', emails: [{ value: '', type: 'home' }], phones: [], tags: ['a', 'b', 'c'], nested: { a: 1, b: { c: 2 } } } }"><p data-sn-text="draft.name"></p></div>`,
      `<button data-sn-on-click="d = { tags: [...d.tags, q.trim()], title: q, size: n + 1, open: !open }"></button>`,
      // a resource list is one call: one statement, however many names
      `<sn-resource name="a" src="/a"></sn-resource><sn-resource name="b" src="/b"></sn-resource><sn-resource name="c" src="/c"></sn-resource><p data-sn-text="a + b + c"></p><button data-sn-on-click="n++; open = false; sel = null; refresh('people', 'a', 'b', 'c')"></button>`,
    ]) expect(warned(body), body).toEqual([]);
  });

  test('each limit, named in the message', () => {
    expect(warned(`<button data-sn-on-click="n = 1; n = 2; n = 3; n = 4; n = 5"></button>`)).toEqual(['`data-sn-on-click` is too complex for markup: 5 statements in one handler (limit `statements`: 4).']);
    expect(warned(`<button data-sn-on-click="open && (sel = null, close())"></button>`)).toEqual(['`data-sn-on-click` is too complex for markup: a condition used as a statement runs 2 steps (limit `guarded`: 1).']);
    expect(warned(`<button data-sn-on-click="open && (n ? close() : refresh('people'))"></button>`)).toEqual(['`data-sn-on-click` is too complex for markup: a condition used as a statement runs 2 steps (limit `guarded`: 1).']);
    expect(warned(`<button data-sn-on-click="(sel = null, close())"></button>`)).toEqual(['`data-sn-on-click` is too complex for markup: 1 comma sequence `(a, b)` (limit `sequences`: 0).']);
    expect(warned(`<p data-sn-text="n === 0 ? 'a' : n === 1 ? 'b' : n === 2 ? 'c' : 'd'"></p>`)).toEqual(['`data-sn-text` is too complex for markup: `?:` nested 3 deep (limit `ternaries`: 2).']);
    expect(warned(`<p data-sn-text="people.filter(p => p.name.trim().toLowerCase().startsWith(q.trim().toLowerCase()) && !p.hidden && p.age * 2 > n).length"></p>`))
      .toEqual(['`data-sn-text` is too complex for markup: 10 operations in one arrow function (limit `arrow`: 8).']);
    expect(warned(`<p data-sn-text="people.map(p => { return p.name; }).join()"></p>`)).toEqual(['`data-sn-text` is too complex for markup: an arrow function with a block body `{ … }` (limit `arrow`).']);
    expect(warned(`<p data-sn-text="(n + 1) * 2 - (n % 3) / 4 + fmt(n, n * 2) + fmt(n - 1) + (open ? n * 3 : n / 3) + (q.length > 2 ? 1 : 0) + -n"></p>`))
      .toEqual([expect.stringMatching(/^`data-sn-text` is too complex for markup: \d+ operations in one expression \(limit `operations`: 15\)\.$/)]);
  });

  test('object attributes are measured per property value', () => {
    expect(warned(`<p data-sn-class="{a: n === 0 ? 'x' : n === 1 ? 'y' : n === 2 ? 'z' : 'w', b: open}"></p>`))
      .toEqual(['`a` in `data-sn-class` is too complex for markup: `?:` nested 3 deep (limit `ternaries`: 2).']);
  });

  test('limits and the level are configurable', () => {
    const body = `<button data-sn-on-click="n = 1; n = 2; n = 3; n = 4; n = 5"></button>`;
    expect(warned(body, { complexity: { statements: 5 } })).toEqual([]);
    expect(warned(`<button data-sn-on-click="open && (sel = null, close())"></button>`, { complexity: { guarded: 2, sequences: 1 } })).toEqual([]);
    expect(diags(page(body), { complexity: { level: 'off' } }).filter((d) => d.code === 'SN507')).toEqual([]);
    const err = diags(page(body), { complexity: { level: 'error' } }).filter((d) => d.code === 'SN507');
    expect(err.map((d) => d.severity)).toEqual(['error']);
    expect(diags(page(body)).find((d) => d.code === 'SN507')!.severity).toBe('warning');
  });

  test('the option is checked', () => {
    expect(complexityOf({ statements: 2, level: 'error' })).toEqual({ statements: 2, level: 'error' });
    expect(() => complexityOf({ statments: 2 } as ComplexityOptions)).toThrow(/`statments` is not a limit; the limits are `statements`/);
    expect(() => complexityOf({ level: 'loud' } as unknown as ComplexityOptions)).toThrow(/`level` is `warn`, `error` or `off`/);
    expect(() => complexityOf({ arrow: -1 })).toThrow(/`arrow` takes a number of 0 or more/);
  });
});

describe('SN516: $meta.<resource>.live of a resource no stream feeds', () => {
  const R = '<sn-resource name="c" src="/api/c" items="contacts" key="id"></sn-resource>';
  const badge = '<p data-sn-text="$meta.c.live"></p>';
  const sync = '<sn-sync src="/api/events"><sn-event name="x" resource="c" op="refetch"></sn-event></sn-sync>';
  const codes = (html: string) => diags(html).map((d) => d.code);
  test('no warning when an <sn-event> names the resource, wherever the sync is on the page', () => {
    expect(codes(R + sync + badge)).not.toContain('SN516');
    expect(codes(badge + R + sync)).not.toContain('SN516');
  });
  test('a sync whose events name another resource, or only run `then`, does not feed it', () => {
    expect(codes(R + '<sn-sync src="/api/events"><sn-event name="x" resource="d" op="refetch"></sn-event></sn-sync>' + badge)).toContain('SN516');
    expect(codes(R + '<sn-sync src="/api/events"><sn-event name="x" then="1"></sn-event></sn-sync>' + badge)).toContain('SN516');
  });
});

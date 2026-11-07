import { describe, expect, test } from 'vitest';
import { compile, CODES } from '../../src/compiler/index.js';

const files: Record<string, string> = {
  '/p/partials/a.html': '<sn-include src="./b.html"></sn-include>',
  '/p/partials/b.html': '<sn-include src="./a.html"></sn-include>',
  '/p/partials/bad.html': '<p>\n  <b data-sn-txt="x"></b></p>',
};

const SPEC = { file: '/p/openapi.json', doc: {
  openapi: '3.0.3',
  paths: { '/api/c': { get: { parameters: [{ name: 'q', in: 'query' }], responses: { '200': { description: 'ok', content: { 'application/json': {
    schema: { type: 'object', properties: { contacts: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } } } } } } } } } },
} };

interface Opts { check?: boolean; openapi?: boolean }

function diags(html: string, o: Opts = {}) {
  return compile(html, {
    file: '/p/page.html', root: '/p', dev: false, check: o.check, openapi: o.openapi ? [SPEC] : undefined,
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
  ['SN104', '<div data-sn-state="{f: null}"><input type="file" data-sn-model="f"></div>', /does not support `type="file"`/],
  ['SN201', `${R}${use}<p data-sn-text="contcts.length"></p>`, /`contcts` is not defined here. Did you mean `contacts`\?/],
  ['SN202', '<p data-sn-text="window.x"></p>', /`window` is a browser API/],
  ['SN203', '<div data-sn-state="{a: 1}"><p data-sn-text="a = 2"></p></div>', /value expressions cannot assign; move this to `data-sn-on-\*`/],
  ['SN204', '<div data-sn-state="{a: 1}"><button data-sn-post="/x" data-sn-optimistic="a = 2"></button></div>', /may only call `patch`, `upsert`, `remove`/],
  ['SN205', `${R}${use}<template data-sn-for="m in messages"><button data-sn-on-click="m.is_read = true"></button></template>`, /`m.is_read` mutates a resource. Use `patch\('messages'/],
  ['SN206', '<p data-sn-text="m.inbox_titel()"></p>', /`m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`\?/],
  ['SN207', '<a data-sn-attr="{onclick: 1}"></a>', /`onclick` cannot be bound with `data-sn-attr`; use `data-sn-on-click`/],
  ['SN209', '<div data-sn-state="{ s: 1 }" data-sn-let="{ s: 2 }"><p data-sn-text="s"></p></div>', /`s` is already defined here; use another name/],
  ['SN301', `${R}${use}<button data-sn-on-click="refresh('mesages')"></button>`, /resource `mesages` is not declared on this page/],
  ['SN302', `${R}${use}<sn-resource name="contacts" src="/x" key="id"></sn-resource>`, /resource `contacts` is declared twice/],
  ['SN303', `${R}${use}<p data-sn-text="$meta.contacts.loadng"></p>`, /`\$meta.contacts.loadng` is not a status field. Did you mean `loading`\?/],
  ['SN304', `${R}${use}<button data-sn-on-click="page('messages', 7)"></button>`, /keyset pagination cannot jump to a page number/],
  ['SN305', '<sn-include src="./partials/contact-dialg.html"></sn-include>', /partial `\.\/partials\/contact-dialg.html` not found or outside the project root/],
  ['SN308', '<sn-resource name="c" src="/api/c" items="contcts"></sn-resource><p data-sn-text="c"></p>', /the response of `GET \/api\/c` has no `contcts`. Did you mean `contacts`\?/, { openapi: true }],
  ['SN306', '<sn-include src="./partials/a.html"></sn-include>', /a.html → b.html → a.html includes itself/],
  ['SN309', '<dialog id="compose"></dialog><button data-sn-on-click="showModal(\'compse\')"></button>', /no `<dialog id="compse">` on this page. Did you mean `compose`\?/],
  ['SN310', '<button data-sn-call="archive(1)"></button>', /`archive` is not exported by the actions module/],
  ['SN401', '<p data-sn-text="a +"></p>', /Unexpected token/],
  ['SN501', R + '<p data-sn-text="messages.length"></p>', /resource `contacts` is declared but never read/],
  ['SN502', '<p data-sn-text="Date.now()"></p>', /`Date.now\(\)` in a binding never updates. Use `\$now`/],
  ['SN503', `${R}${use}<template data-sn-for="c in contacts"><a data-sn-attr="{id: c.id}"></a></template>`, /`id` bound from data can shadow globals/],
  ['SN504', `${R}${use}`, /resource `contacts` has no type: expressions using it are not checked/, { check: true }],
  ['SN506', `${R}${use}<sn-sync src="/api/events"><sn-event name="contact_updated" resource="contacts" op="upsert" item="contact"></sn-event></sn-sync>`, /event `contact_updated` has no type: expressions reading its payload are not checked/, { check: true }],
  ['SN505', '<sn-resource name="c" src="/api/c?qq=1" items="contacts"></sn-resource><p data-sn-text="c"></p>', /`GET \/api\/c` declares no query parameter `qq`. Did you mean `q`\?/, { openapi: true }],
];

/** Codes that do not come from compile(): `sinter check` runs TypeScript (SN208), loading a spec fails (SN307). Fixtures in test/check. */
const CHECK_ONLY = ['SN208', 'SN307'];

describe('every diagnostic code has a failing fixture', () => {
  test('all codes covered', () => {
    expect(new Set([...cases.map((c) => c[0]), ...CHECK_ONLY])).toEqual(new Set(Object.keys(CODES)));
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

describe('positions', () => {
  test('point into the attribute value', () => {
    const d = diags('<div>\n  <p data-sn-text="1 + contcts"></p>\n</div>')[0]!;
    expect([d.line, d.col]).toEqual([2, 24]);
  });
  test('point into the partial, followed by the include chain', () => {
    const d = diags('<div>\n<sn-include src="./partials/bad.html"></sn-include></div>')[0]!;
    expect(d.file).toBe('/p/partials/bad.html');
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

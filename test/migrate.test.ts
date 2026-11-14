import { describe, expect, test } from 'vitest';
import { addQuery, configReport, followUp, formatReport, migrateMarkup, relativeUrl, removeAttributes } from '../src/migrate.js';
import { compile } from '../src/compiler/index.js';
import { apiProject } from './apis.test.js';

const p = apiProject({ apis: { main: { openapi: 'openapi.yml' }, files: { base: '/files' } }, defaultApi: 'main' });

describe('sinter migrate', () => {
  test('a URL becomes the path relative to the API with the longest base; api: unless it is the default', () => {
    expect(relativeUrl(p.apis!, 'https://api.example.com/v1/contacts/{c.id}?q={q}')).toBe('/contacts/{c.id}?q={q}');
    expect(relativeUrl(p.apis!, '/files/upload')).toBe('files:/upload');
    expect(relativeUrl(p.apis!, 'https://elsewhere.example/x')).toBeNull();
    // already relative, or under no same-origin base: unchanged (a second run changes nothing)
    expect(relativeUrl(p.apis!, '/contacts')).toBeNull();
    expect(relativeUrl(p.apis!, 'files:/upload')).toBeNull();
  });

  test('rewrites attribute values only, byte for byte, in templates too; idempotent', () => {
    const page = `<sn-resource name="c" src="https://api.example.com/v1/contacts" items="contacts" key="id"></sn-resource>
<template data-sn-for="x in c"><button data-sn-delete='https://api.example.com/v1/contacts/{x.id}'>&amp; x</button></template>
<sn-resource name="cfg" src="/config.json"></sn-resource>`;
    const r = migrateMarkup(page, 'page.html', p.apis!);
    expect(r.text).toBe(page.replace('https://api.example.com/v1/contacts"', '/contacts"').replace("https://api.example.com/v1/contacts/{x.id}'", "/contacts/{x.id}'"));
    expect(r.rewrites.map((w) => [w.line, w.to])).toEqual([[1, '/contacts'], [2, '/contacts/{x.id}']]);
    // a same-origin path under no base: reported, as the default API has a base
    expect(r.unsure).toEqual([{ line: 3, from: '/config.json', to: 'site:/config.json' }]);
    expect(migrateMarkup(r.text, 'page.html', p.apis!).rewrites).toEqual([]);
  });

  test('the config to add: shapes every page agrees on, endpoints no API declares', () => {
    const a = migrateMarkup('<sn-resource name="c" src="/contacts" items="contacts" key="id"></sn-resource><sn-resource name="s" src="/stats" key="day"></sn-resource>', 'a.html', p.apis!);
    const b = migrateMarkup('<sn-resource name="c" src="/contacts" items="contacts" key="id"></sn-resource><form data-sn-post="files:/upload"></form>', 'b.html', p.apis!);
    const report = configReport([...a.uses, ...b.uses], p.apis!, p.openapi);
    expect(report.defaults).toEqual({ main: { 'GET /contacts': { items: 'contacts', key: 'id' } } });
    expect(report.operations).toEqual({ main: { 'GET /stats': { key: 'day', '': 'type' } }, files: { 'POST /upload': {} } });
    expect(formatReport(report)).toContain(`"GET /stats": { key: "day", /* type: '…' */ },`);
    const c = migrateMarkup('<sn-resource name="c" src="/contacts" items="people" key="id"></sn-resource>', 'c.html', p.apis!);
    expect(configReport([...a.uses, ...c.uses], p.apis!, p.openapi).disagree).toEqual(['main: GET /contacts (items)']);
  });

  test('site: in a file it migrates, for a same-origin path no operation of the default API matches', () => {
    const page = `<sn-resource name="c" src="https://api.example.com/v1/contacts" key="id"></sn-resource>
<sn-resource name="cfg" src="/config.json"></sn-resource>
<sn-resource name="one" src="/contacts/{1}"></sn-resource>`;
    const r = migrateMarkup(page, 'page.html', p.apis!, p.openapi);
    expect(r.rewrites.map((w) => w.to)).toEqual(['/contacts', 'site:/config.json']);
    // `/contacts/{1}` is also an operation of the default API: the page's own, or the API's? Reported
    expect(r.unsure.map((w) => w.from)).toEqual(['/contacts/{1}']);
    // a file migrated before: `/stats` may be the API's, not declared yet; it stays, reported
    const again = migrateMarkup('<sn-resource name="s" src="/stats" key="day"></sn-resource>', 'b.html', p.apis!, p.openapi);
    expect([again.rewrites, again.unsure.map((w) => w.to)]).toEqual([[], ['site:/stats']]);
    expect(migrateMarkup(r.text, 'page.html', p.apis!, p.openapi).rewrites).toEqual([]);
  });

  test('after the rewrite: the query parameters to declare, what to fix by hand, the attributes to remove', () => {
    const q = apiProject({ apis: { main: { openapi: 'openapi.yml', defaults: { 'GET /contacts': { items: 'contacts', key: 'id' } } } } });
    const page = `<div data-sn-state="{ t: '' }">
<sn-resource name="c" src="https://api.example.com/v1/contacts?tag={t}&qq={t}" items="contacts" key="id" paginate="offset" page-size="10" size-param="per"></sn-resource>
<sn-resource name="r" src="https://api.example.com/v1/reports"></sn-resource>
<p data-sn-text="c.length + r.n"></p></div>`;
    const m = migrateMarkup(page, `${q.root}/page.html`, q.apis!, q.openapi);
    const read = (f: string) => (f === `${q.root}/page.html` ? m.text : q.readFile(f));
    const d = compile(m.text, { file: `${q.root}/page.html`, root: q.root, dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: read, openapi: q.openapi, apis: q.apis }).diagnostics;
    const fu = followUp(d);
    // `per` and `page` are what `paginate="offset"` sends
    expect(fu.query.map((x) => x.name)).toEqual(['tag', 'per', 'page']);
    expect(fu.notes.map((n) => n.replace(/^[^ ]+ +/, ''))).toEqual([
      '`GET /contacts` of the API `main` declares no query parameter `qq`. Did you mean `q`?',
      '`GET /reports` of the API `main` needs the query parameter `from`',
    ]);
    const report = configReport(m.uses, q.apis!, q.openapi);
    addQuery(report, fu.query, q.apis!, q.openapi);
    expect(report.defaults.main!['GET /contacts']).toEqual({ query: ['tag', 'per', 'page'] });
    expect(formatReport(report)).toContain('"GET /contacts": { query: ["tag","per","page"] },');
    // `items` and `key` are in the config: removed, with the space before each
    expect(fu.redundant).toHaveLength(2);
    expect(removeAttributes(m.text, fu.redundant.map((x) => x.span))).toContain('<sn-resource name="c" src="/contacts?tag={t}&qq={t}" paginate="offset"');
  });
});


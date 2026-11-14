import { describe, expect, test } from 'vitest';
import { configReport, formatReport, migrateMarkup, relativeUrl } from '../src/migrate.js';
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
});

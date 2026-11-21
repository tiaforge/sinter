// @vitest-environment node
// The URL rules of @tiaforge-ui/sinter/server on the cases packages/sinter-axum and packages/sinter-aspnetcore
// run too (test/fixtures/server-cases.json).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { lists } from '../../src/runtime/lists.js';
import { readUrl, withParams } from '../../src/runtime/url.js';
import { describedUrl, escape } from '../../src/server.js';
import { pathTable } from '../../src/server-table.js';

type Params = Record<string, string | string[]>;
type Placeholder = Parameters<typeof describedUrl>[0];
type Described = Omit<Placeholder, 'id' | 'resource'>;
const CASES: {
  params: Array<{ path: string; query?: string; patterns: string[]; arrays?: string[]; want: Params }>;
  expand: Array<{ src: Placeholder['src']; params: Params; want: string | null }>;
  withParams: Array<{ url: string; set: Array<[string, string]>; want: string }>;
  described: Array<{ placeholder: Described; params: Params; want: string | null }>;
  when: Array<{ when: Placeholder['when']; params: Params; holds: boolean }>;
  match: Array<{ rules: Array<{ pattern: string; exact?: boolean }>; paths: Array<[string, number | null]> }>;
  escape: Array<{ json: string; want: string }>;
} = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/server-cases.json'), 'utf8'));

const described = (p: Described, params: Params) => describedUrl({ id: 0, resource: 'r', ...p }, params);

describe('the shared cases', () => {
  test('params: `$url` from the path and the query', () => {
    for (const c of CASES.params) {
      const href = `http://app.test${c.path}${c.query == null ? '' : '?' + c.query}`;
      expect({ ...lists(href, c.arrays ?? [], readUrl(href, c.patterns)) }, `${c.path} ${c.query}`).toEqual(c.want);
    }
  });

  test('expand: a template filled from `$url`', () => {
    for (const c of CASES.expand) expect(described({ src: c.src }, c.params), JSON.stringify(c)).toBe(c.want);
  });

  test('withParams: query parameters set on a URL', () => {
    for (const c of CASES.withParams) expect(withParams(c.url, Object.fromEntries(c.set)), JSON.stringify(c)).toBe(c.want);
  });

  test('described: the request the build describes for a placeholder', () => {
    for (const c of CASES.described) expect(described(c.placeholder, c.params), JSON.stringify(c)).toBe(c.want);
  });

  test("when: whether a placeholder's `when` holds", () => {
    for (const c of CASES.when) expect(described({ src: ['/x'], when: c.when }, c.params) != null, JSON.stringify(c)).toBe(c.holds);
  });

  test('match: the first rule in order for a path', () => {
    for (const c of CASES.match) {
      const find = pathTable(c.rules.map((r) => ({ pattern: r.pattern, exact: r.exact ?? false })));
      for (const [path, want] of c.paths) expect(find(path), path).toBe(want ?? Infinity);
    }
  });

  test('escape: the JSON written into a placeholder', () => {
    const enc = new TextEncoder(), dec = new TextDecoder();
    for (const c of CASES.escape) expect(dec.decode(escape(enc.encode(c.json))), c.json).toBe(c.want);
  });
});

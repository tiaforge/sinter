// @vitest-environment jsdom
// A resource without `key` that the build knows is a list (its `type`, the OpenAPI response at `select`, a `file:` or
// `content:` list) is `[]` when it has no data: while it loads, while `when` is falsy, after `remove()`. A list of
// strings (RealWorld's tags) cannot have a key, so markup over it needs no `?.length` or `?? []`. A resource whose type
// the build does not know stays `null`.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { isArrayType } from '../../src/compiler/components.js';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const OPTS = { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); } };
const SPEC = { file: '/p/openapi.json', doc: {
  openapi: '3.0.3',
  paths: {
    '/api/tags': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } } } } } } },
    '/api/me': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } } } } },
  },
} };
const ls = (html: string, o: object = {}) => Object.fromEntries(compileParts(html, { ...OPTS, ...o }).ir.resources.map((r) => [r.name, r.ls ?? 0]));

describe('which resources are lists', () => {
  test('isArrayType: the type as written', () => {
    for (const t of ['string[]', ' readonly string[] ', 'Tag[]', '{ a: number }[]', '(A | B)[]', '(() => void)[]', 'Array<string>', 'ReadonlyArray<Tag>', 'Array<Array<1>>', 'string[][]', '(string[])', "('a' | ']')[]"])
      expect(isArrayType(t), t).toBe(true);
    for (const t of ['string', 'Tags', 'A | B[]', 'A[] | null', 'A & B[]', 'keyof X[]', 'typeof x', 'X[number]', 'Array<A> | B', '() => A[]', 'T extends U ? A[] : B[]', '{ tags: string[] }', 'any'])
      expect(isArrayType(t), t).toBe(false);
  });

  test('by `type`, by the OpenAPI response at `select`; not with `key`, an unknown type or one object', () => {
    expect(ls(`<sn-resource name="a" src="/x" type="string[]"></sn-resource><sn-resource name="b" src="/x" type="Tag"></sn-resource>
      <sn-resource name="c" src="/x"></sn-resource><sn-resource name="d" src="/x" key="id" type="Tag[]"></sn-resource><sn-resource name="e" src="/x" type="any"></sn-resource>
      <p data-sn-text="[a, b, c, d, e]"></p>`)).toEqual({ a: 1, b: 0, c: 0, d: 0, e: 0 });
    expect(ls('<sn-resource name="t" src="/api/tags" select="tags"></sn-resource><sn-resource name="all" src="/api/tags"></sn-resource><sn-resource name="me" src="/api/me"></sn-resource><p data-sn-text="[t, all, me]"></p>', { openapi: [SPEC] }))
      .toEqual({ t: 1, all: 0, me: 0 });
  });

  test('a `file:` JSON list without `key`', () => {
    const files: Record<string, string> = { '/p/tags.json': '["a","b"]', '/p/site.json': '{"name":"x","tags":["a"]}' };
    const out = compileParts('<sn-resource name="t" src="file:./tags.json"></sn-resource><sn-resource name="s" src="file:./site.json"></sn-resource><sn-resource name="st" src="file:./site.json" select="tags"></sn-resource><p data-sn-text="[t, s, st]"></p>',
      { ...OPTS, readFile: (p: string) => { if (p in files) return files[p]!; throw new Error('missing'); } });
    expect(Object.fromEntries(out.ir.resources.map((r) => [r.name, r.ls ?? 0]))).toEqual({ t: 1, s: 0, st: 1 });
  });
});

describe('the empty value', () => {
  test('`[]` while loading, while `when` is falsy and after `remove()`; a resource of unknown type stays null', async () => {
    // answered at settle()
    const requests = mockRequests({ 'GET /api/tags': ['go', 'js'] });
    const { root, settle, flush } = await render(`<div data-sn-state="{ on: true }">
      <sn-resource name="tags" src="/api/tags" type="string[]" when="on"></sn-resource>
      <sn-resource name="other" src="/api/other" type="any" when="false"></sn-resource>
      <p id="n" data-sn-text="tags.length + ':' + (other === null)"></p>
      <ul><template data-sn-for="t in tags" data-sn-key="t"><li data-sn-text="t"></li></template></ul>
      <button id="off" data-sn-on-click="on = false"></button><button id="on" data-sn-on-click="on = true"></button><button id="rm" data-sn-on-click="remove(tags)"></button>
    </div>`, { requests });
    const n = () => root.querySelector('#n')!.textContent;
    expect(n()).toBe('0:true');
    await settle();
    expect(n()).toBe('2:true');
    expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['go', 'js']);
    (root.querySelector('#rm') as HTMLButtonElement).click();
    await settle();
    expect(n()).toBe('0:true');
    (root.querySelector('#on') as HTMLButtonElement).click();
    (root.querySelector('#off') as HTMLButtonElement).click();
    flush();
    expect(n()).toBe('0:true');
    expect(root.querySelectorAll('li').length).toBe(0);
  });

  describe('before the page module', () => {
    afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });
    const PAGE = (type: string) => `<!doctype html><html><head></head><body>
      <sn-resource name="tags" src="/api/tags" type="${type}"></sn-resource>
      <template data-sn-if="$meta.tags.loading && !tags.length"><p id="loading">Loading…</p></template>
      <ul><template data-sn-for="t in tags" data-sn-key="t"><li data-sn-text="t"></li></template></ul></body></html>`;

    test('the early script reads a loading list as `[]`: its loading branch is in the first paint', async () => {
      vi.stubGlobal('fetch', () => new Promise(() => {}));
      await firstPaint(PAGE('string[]'));
      expect(document.getElementById('loading')).not.toBeNull();
      // one object: `null.length` is left to the page module
      await firstPaint(PAGE('any'));
      expect(document.getElementById('loading')).toBeNull();
    });

    test('embedded data that is `null`: `[]` early and in the page module', async () => {
      const page = (type: string) => PAGE(type).replace('<head></head>', '<head><script type="application/json" data-sn-resource="tags">null</script></head>')
        .replace('<ul>', '<p id="n" data-sn-text="tags.length"></p><ul>');
      let early: string | null | undefined;
      const { root, settle } = await render(page('string[]'), { firstPaint: { afterEarly: () => { early = document.getElementById('n')?.textContent; } } });
      await settle();
      expect(early).toBe('0');
      expect(root.querySelector('#n')!.textContent).toBe('0');
    });
  });
});

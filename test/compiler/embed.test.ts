// Embedded-data placeholders as the build describes them for a server (`sinter-embed.json`): the
// `data-sn` id, and the request when literals and plain `$url` reads make it up.
import { expect, test } from 'vitest';
import { compileParts, type CompileOptions } from '../../src/compiler/index.js';

const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: '/app/helpers.js', names: ['offset'], namespaces: {} } };

test('a keyset resource: its first page is the size and the `first` direction, under their parameter names', () => {
  const out = compileParts(`<!doctype html><html><head><script type="application/json" data-sn-data="m"></script></head><body>
    <sn-resource name="m" key="uid" src="/api/m?folder=inbox" items="messages" paginate="keyset" page-size="50" size-param="n" cursor="{at}" direction-values="{ first: 'top' }"></sn-resource>
    <p data-sn-text="m.length"></p></body></html>`, opts);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.embed[0]).toMatchObject({ resource: 'm', src: ['/api/m?folder=inbox'], query: [['n', '50'], ['direction', 'top']] });
});

test('each placeholder: its id, and the URL template where only the URL decides it; null where a helper or a value of the page does', () => {
  const out = compileParts(`<!doctype html><html data-sn-path="/article/:slug"><head>
    <script type="application/json" data-sn-data="article"></script>
    <script type="application/json" data-sn-data="list"></script>
    <script type="application/json" data-sn-data="mine"></script>
    <script type="application/json" data-sn-data="rows"></script>
  </head><body data-sn-state="{ q: '' }">
    <sn-resource name="article" src="https://api.example/articles/{$url.slug}?v={$url.v}"></sn-resource>
    <sn-resource name="list" key="id" src="/api/list?offset={offset($url.page, 10)}"></sn-resource>
    <sn-resource name="mine" key="id" src="/api/mine?q={q}" when="q"></sn-resource>
    <sn-resource name="rows" key="id" src="/api/rows" items="rows" total="total" paginate="offset" page-size="2"></sn-resource>
    <sn-resource name="other" src="/api/other"></sn-resource>
    <p data-sn-text="article.title + list.length + mine.length + rows.length + other.x"></p>
  </body></html>`, opts);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const by = Object.fromEntries(out.embed.map((d) => [d.resource, d]));
  expect(Object.keys(by).sort()).toEqual(['article', 'list', 'mine', 'rows']);
  expect(by.article).toEqual({ id: by.article!.id, resource: 'article', src: ['https://api.example/articles/', { url: 'slug' }, '?v=', { url: 'v' }] });
  expect(by.list!.src).toBeNull();
  expect(by.mine).toMatchObject({ src: null, when: true });
  // paginated: the first page's parameters, as the pager sends them
  expect(by.rows).toMatchObject({ src: ['/api/rows'], query: [['page', '1'], ['limit', '2']] });
  // ids as in the HTML, in document order
  expect(out.embed.map((d) => d.id)).toEqual([...out.embed.map((d) => d.id)].sort((a, b) => a - b));
  for (const d of out.embed) expect(out.html).toContain(`<script type="application/json" data-sn="${d.id}"></script>`);
});

test('start-page: a `$url` value is described (the page parameter, from page 2 on); anything else is not; it needs a mode that asks for a page by number', () => {
  const page = (attrs: string, extra = '') => compileParts(`<!doctype html><html><head><script type="application/json" data-sn-data="m"></script></head><body data-sn-state="{ n: 2 }">
    <sn-resource name="m" key="id" src="/api/m" items="items" total="total" ${attrs}></sn-resource>${extra}
    <p data-sn-text="m.length"></p></body></html>`, opts);
  const off = page('paginate="offset" page-size="10" size-param="limit" offset-param="offset" start-page="$url.page"');
  expect(off.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(off.embed[0]).toMatchObject({ src: ['/api/m'], query: [['offset', '0'], ['limit', '10']], start: { url: 'page', key: 'offset', size: 10, skip: true, query: [['offset', '10'], ['limit', '10']] } });
  const num = page('paginate="offset" page-size="10" start-page="$url.p"');
  expect(num.embed[0]).toMatchObject({ query: [['page', '1'], ['limit', '10']], start: { url: 'p', key: 'page', size: 10, query: [['page', '2'], ['limit', '10']] } });
  expect(num.embed[0]!.start).not.toHaveProperty('skip');
  // a state value: not known to a server
  expect(page('paginate="offset" page-size="10" start-page="n"').embed[0]!.src).toBeNull();
  const codes = (attrs: string) => page(attrs).diagnostics.map((d) => `${d.code} ${d.message}`);
  expect(codes('key="id" paginate="append" page-size="5" cursor="{after: id}" start-page="$url.page"')).toContainEqual(expect.stringMatching(/^SN401 `start-page` needs a resource that can ask for a page by number/));
  expect(codes('paginate="keyset" page-size="5" cursor="{after: id}" start-page="$url.page"')).toContainEqual(expect.stringMatching(/^SN401 `start-page` needs/));
  expect(codes('start-page="$url.page"')).toContainEqual('SN102 `start-page` needs `paginate`');
  // offset-param in offset mode is accepted; in append mode it is not
  expect(codes('paginate="offset" page-size="5" offset-param="skip"').filter((c) => c.startsWith('SN4'))).toEqual([]);
  expect(codes('paginate="append" page-size="5" cursor="{after: id}" offset-param="skip"')).toContainEqual(expect.stringMatching(/^SN401 `offset-param` applies to `paginate="offset"`/));
});

test('when: `$url` values against strings, `!`, `&&`, `||` are a condition a server evaluates; anything else only the browser can', () => {
  const when = (w: string) => compileParts(`<!doctype html><html><head><script type="application/json" data-sn-data="m"></script></head><body data-sn-state="{ q: '' }">
    <sn-resource name="m" src="/api/m" when="${w}"></sn-resource><p data-sn-text="m.x"></p></body></html>`, opts).embed[0]!.when;
  expect(when("$url.feed != 'following'")).toEqual({ url: 'feed', ne: 'following' });
  expect(when("'a' === $url.tab")).toEqual({ url: 'tab', eq: 'a' });
  expect(when("!$url.q || ($url.tab == 'x' && $url.n)")).toEqual({ or: [{ not: { url: 'q' } }, { and: [{ url: 'tab', eq: 'x' }, { url: 'n' }] }] });
  // a number (loose equality with a string), a state value, a helper, `??`: the browser's
  for (const w of ['$url.page == 1', 'q', '$url.tab == q', 'offset($url.page, 10)', "$url.a ?? 'b'"]) expect(when(w)).toBe(true);
});

test('array parameters: the page lists them for the server and the early file; a `when` reading one is the browser\'s', () => {
  const out = compileParts(`<!doctype html><html><head>
    <script type="application/json" data-sn-data="a"></script><script type="application/json" data-sn-data="b"></script>
  </head><body>
    <select multiple data-sn-model="$url.tag"><option>go</option></select>
    <sn-resource name="a" key="id" src="/api/a?tag={$url.tag}" when="$url.tag.length"></sn-resource>
    <sn-resource name="b" key="id" src="/api/b?q={$url.q}" when="$url.q"></sn-resource>
    <p data-sn-text="a.length + b.length"></p></body></html>`, { ...opts, early: { module: null } });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.ir.urlArrays).toEqual(['tag']);
  expect(out.embed.map((s) => [s.resource, s.when])).toEqual([['a', true], ['b', { url: 'q' }]]);
  expect(out.early?.ir.urlArrays).toEqual(['tag']);
});

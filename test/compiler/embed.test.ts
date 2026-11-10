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

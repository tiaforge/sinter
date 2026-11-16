// `content:` resources (docs/resources.md#collections): a collection of the content module, loaded before the compile
// (`collections`), is a constant list as a `file:` glob is: it folds, sorts by `order`, keys by the collection's key,
// and a `data-sn-pages` page can be built from it. An unknown name is SN342.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { scrub } from '../../src/content-node.js';

const collections = new Map<string, { key: string; value: readonly unknown[] }>([
  ['products', { key: 'sku', value: [{ sku: 'b-2', name: 'Bolt', price: 2 }, { sku: 'a-1', name: 'Anchor', price: 10 }] }],
  ['tags', { key: 'slug', value: [] }],
]);
const build = (html: string, o: Record<string, unknown> = {}) => compile(html, {
  file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} },
  readFile: () => { throw new Error('no files'); }, listFiles: () => [], collections, ...o,
});
const errors = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
const page = (body: string) => `<!doctype html><html lang="en"><head></head><body>${body}</body></html>`;

describe('content: resources', () => {
  test('a collection folds into the page, sorted by `order`', () => {
    const out = build(page('<sn-resource name="products" src="content:products" order="name"></sn-resource><ul><template data-sn-for="p in products"><li data-sn-text="p.name + \' \' + p.price"></li></template></ul>'));
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<li>Anchor 10<\/li><li>Bolt 2<\/li>/);
    expect(out.html).not.toContain('application/json');
  });

  test('SN342: a name the content module does not export, with a "did you mean"', () => {
    const out = build(page('<sn-resource name="p" src="content:product"></sn-resource><p data-sn-text="p.length"></p>'));
    expect(errors(out)).toEqual([expect.stringMatching(/^SN342 `product` is not a collection of the content module \(it has `products`, `tags`\)/)]);
    expect(out.diagnostics.find((d) => d.code === 'SN342')!.hint).toMatch(/content:products/);
    // a module that failed to load (dev): its error, where a page reads a collection
    expect(errors(build(page('<sn-resource name="p" src="content:products"></sn-resource><p data-sn-text="p.length"></p>'), { collections: new Map(), collectionsError: 'collection `products`: CMS: 500' })))
      .toEqual([expect.stringMatching(/^SN342 `products`: the content module did not load its collections: collection `products`: CMS: 500/)]);
  });

  test('SN332: `drafts` and `items` are the loader\'s business; what would load it', () => {
    const one = (a: string) => errors(build(page(`<sn-resource name="p" src="content:products" ${a}></sn-resource><p data-sn-text="p.length"></p>`)));
    expect(one('drafts="draft"')).toEqual([expect.stringMatching(/^SN332 `drafts` is a `file:` glob's; a collection leaves its drafts out in its loader/)]);
    expect(one('items="x"')).toEqual([expect.stringMatching(/^SN332 `items` picks a list out of a value; a collection is a list already/)]);
    expect(one('refresh="30s"')).toEqual([expect.stringMatching(/^SN332 `refresh` reloads, and a `content:` resource is a constant/)]);
  });

  test('a page per entry of a collection', () => {
    const html = '<!doctype html><html data-sn-path="/shop/:sku" data-sn-pages="product in products"><head><title data-sn-text="product.name"></title></head><body><sn-resource name="products" src="content:products"></sn-resource><h1 data-sn-text="product.name"></h1></body></html>';
    const t = build(html);
    expect(errors(t)).toEqual([]);
    expect(t.pages!.entries.map((e) => e.path)).toEqual(['/shop/b-2', '/shop/a-1']);
    const out = build(html, { page: t.pages!.entries[1] });
    expect(out.html).toContain('<title>Anchor</title>');
    expect(out.html).toContain('<h1>Anchor</h1>');
  });

  test('without collections (`sinter check`, the editor): an empty list, no error', () => {
    const out = build(page('<sn-resource name="products" src="content:products"></sn-resource><p data-sn-text="products.length"></p>'), { collections: undefined });
    expect(errors(out)).toEqual([]);
  });
});

describe('`fields`: what the browser gets of a list', () => {
  const embedded = (out: ReturnType<typeof build>) => { const m = /<script type="application\/json" data-sn="\d+">([\s\S]*?)<\/script>/.exec(out.html); return m ? JSON.parse(m[1]!) : undefined; };
  const reads = (res: string) => page(`${res}<div data-sn-state="{ q: '' }"><input data-sn-model="q"><ul><template data-sn-for="p in products.filter((p) => p.name.includes(q))"><li data-sn-text="p.name"></li></template></ul></div>`);
  test('a collection that browser code reads ships only with `fields`, and only those (SN344 without)', () => {
    const without = build(reads('<sn-resource name="products" src="content:products"></sn-resource>'));
    expect(errors(without)).toEqual([expect.stringMatching(/^SN344 browser code reads `products`, a collection, so it would ship to the page: name the fields it gets with `fields="…"`/)]);
    const named = build(reads('<sn-resource name="products" src="content:products" fields="sku,name"></sn-resource>'));
    expect(errors(named)).toEqual([]);
    expect(embedded(named)).toEqual([{ sku: 'b-2', name: 'Bolt' }, { sku: 'a-1', name: 'Anchor' }]);
  });
  test('read only at build time: nothing ships, and no `fields` is needed', () => {
    const out = build(page('<sn-resource name="products" src="content:products"></sn-resource><p data-sn-text="products.map((p) => p.name).join(\', \')"></p>'));
    expect(errors(out)).toEqual([]);
    expect(out.html).toContain('<p>Bolt, Anchor</p>');
    expect(embedded(out)).toBeUndefined();
  });
  test('a `file:` list may ship whole; `fields` prunes it too; a malformed list is SN332', () => {
    const files = { 'd/a.json': '{"name":"A","secret":1}' };
    const o = { readFile: (f: string) => files[f.replace('/p/', '') as keyof typeof files], listFiles: () => ['/p/d/a.json'] };
    const res = (attrs: string) => reads(`<sn-resource name="products" src="file:/d/*.json" type="any"${attrs}></sn-resource>`);
    expect(embedded(build(res(''), o))).toEqual([{ name: 'A', secret: 1, slug: 'a', dir: '', path: '/d/a.json' }]);
    expect(embedded(build(res(' fields="name"'), o))).toEqual([{ name: 'A' }]);
    expect(errors(build(res(' fields="name, 2x"'), o))).toEqual([expect.stringMatching(/^SN332 `fields` lists the fields of each entry/)]);
  });
});

describe('scrubbing a loader\'s error', () => {
  test('URLs lose their credentials and query; secrets from the environment are masked', () => {
    expect(scrub('fetch https://user:pw@cms.example.com/api/items?token=abc123&x=1 failed', {})).toBe('fetch https://cms.example.com/api/items?… failed');
    expect(scrub('401 with key sk-live-0123456789', { CMS_TOKEN: 'sk-live-0123456789', SHORT: 'abc' })).toBe('401 with key ***');
  });
});

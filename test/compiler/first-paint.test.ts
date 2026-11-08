// First paint at compile time: which bindings are written into the HTML, and the data for the
// first-paint script.
import { expect, test } from 'vitest';
import { compile, type CompileOptions, type FirstPaintOptions } from '../../src/compiler/index.js';

const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body data-sn-state="{ here: '/a/', at: $now }">${body}</body></html>`;

function build(html: string, firstPaint: FirstPaintOptions = {}, helpers: Record<string, unknown> = {}) {
  const manifest: CompileOptions['helpers'] = { module: '/h.js', names: [], namespaces: {} };
  for (const [k, v] of Object.entries(helpers)) {
    if (typeof v === 'function') manifest.names.push(k);
    else manifest.namespaces[k] = { module: `/${k}.js`, members: Object.keys(v as object) };
  }
  const out = compile(html, { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: manifest, firstPaint: { helpers, ...firstPaint } });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const body = out.html.slice(out.html.indexOf('<body'));
  return { html: out.html, body, data: out.firstPaint };
}

test('literal state, constants and helpers: written into the HTML; resources, $now and $url: left to the page module', () => {
  const { body, data } = build(page(`
    <sn-resource name="user" src="/api/user"></sn-resource>
    <a href="/a/" data-sn-attr="{'aria-current': here === '/a/' ? 'page' : null, 'data-tooltip': label('Mail')}"><span data-sn-text="label('Mail')"></span></a>
    <a href="/b/" data-sn-attr="{'aria-current': here === '/b/' ? 'page' : null}">B</a>
    <p data-sn-text="user.name">…</p>
    <p data-sn-text="at">…</p>
    <p data-sn-show="here === '/b/'" data-sn-class="{on: here.length > 1, off: !here}" data-sn-style="{'--w': 2 + 'px'}">x</p>
    <input type="checkbox" data-sn-model="flag" data-sn-state="{ flag: true }">
    <template data-sn-if="here"><b data-sn-text="here"></b></template>`), {}, { label: (s: string) => `[${s}]` });
  expect(body).toContain('<a href="/a/" data-sn="1" aria-current="page" data-tooltip="[Mail]"><span data-sn="2">[Mail]</span></a>');
  expect(body).toContain('<a href="/b/" data-sn="3">B</a>');
  expect(body).toContain('<p data-sn="4">…</p>');
  expect(body).toContain('<p data-sn="5">…</p>');
  expect(body).toContain('<p data-sn="6" hidden="" class="on" style="--w: 2px">x</p>');
  expect(body).toContain('<input type="checkbox" data-sn="7" checked="">');
  // templates render when the page module runs
  expect(body).toContain('<template data-sn="8"><b></b></template>');
  // nothing for a first-paint script to do
  expect(data).toBeNull();
});

test('a helper that throws, an object value, a refused URL or style, and a text binding over elements stay runtime-only', () => {
  const { body } = build(page(`
    <p data-sn-text="boom()">a</p>
    <p data-sn-text="{ x: 1 }">b</p>
    <a data-sn-attr="{href: 'javascript:alert(1)', title: 'ok'}">c</a>
    <p data-sn-style="{background: 'url(x.png)'}">d</p>
    <p data-sn-text="here"><b>e</b></p>
    <p data-sn-text="Math.random()">f</p>
    <p data-sn-text="new Date(0).getFullYear()">g</p>`), {}, { boom: () => { throw new Error('no'); } });
  expect(body).toContain('<p data-sn="1">a</p>');
  expect(body).toContain('<p data-sn="2">b</p>');
  expect(body).toContain('<a data-sn="3" title="ok">c</a>');
  expect(body).toContain('<p data-sn="4">d</p>');
  expect(body).toContain('<p data-sn="5"><b>e</b></p>');
  expect(body).toContain('<p data-sn="6">f</p>');
  expect(body).toContain('<p data-sn="7">g</p>');
});

test('without the helpers module, bindings that call helpers stay runtime-only', () => {
  const html = page('<p data-sn-text="label(here)"></p><p data-sn-text="here"></p>');
  const out = compile(html, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', firstPaint: { helpers: null },
    helpers: { module: '/h.js', names: ['label'], namespaces: {} },
  });
  expect(out.html).toContain('<p data-sn="1"></p><p data-sn="2">/a/</p>');
});

test('persisted values: the control is listed for the first-paint script, and what reads the value waits for the page module', () => {
  const { body, data } = build(`<!doctype html><html><head></head><body>
    <nav data-sn-state="{ collapsed: false, wide: true }" data-sn-attr="{'aria-expanded': !collapsed, 'data-wide': wide}">
      <input type="checkbox" data-sn-model="collapsed" data-sn-persist="nav-collapsed">
    </nav>
    <form data-sn-state="{ q: 'x', kind: 'all' }" data-sn-persist="filters">
      <input data-sn-model="q"><span data-sn-text="q"></span>
      <select data-sn-model="kind"><option>all</option></select>
    </form></body></html>`);
  // the model's own initial value is the fallback; storage, if any, wins in the first-paint script
  expect(body).toContain('<nav data-sn="0" data-wide="">');
  expect(body).toContain('<input type="checkbox" data-sn="1">');
  expect(body).toContain('<input data-sn="3"><span data-sn="4"></span>');
  expect(data).toEqual({ p: [[1, 'nav-collapsed', 'checkbox'], [3, 'filters', 'text', 'q'], [5, 'filters', 'select', 'kind']] });
});

test('locales: the HTML in the first, the others in the first-paint data where they differ', () => {
  let locale = 'en';
  const m = { nav: () => (locale === 'de' ? 'Navigation </script>' : 'Navigation'), brand: () => 'Caley' };
  const html = page('<nav data-sn-attr="{\'aria-label\': m.nav()}"><b data-sn-text="m.brand()"></b><i data-sn-text="$locale"></i></nav>', '<title data-sn-text="m.brand()"></title>');
  const { body, data, html: out } = build(html, { locale: { locales: ['en', 'de'], storage: 'locale', use: (l) => { locale = l; } } }, { m });
  expect(body).toContain('<nav data-sn="2" aria-label="Navigation"><b data-sn="3">Caley</b><i data-sn="4">en</i></nav>');
  expect(out).toContain('<title data-sn="0">Caley</title>');
  expect(data).toEqual({
    l: { locales: ['en', 'de'], storage: 'locale' },
    t: { de: [[2, 'attr', 'aria-label', 'Navigation </script>'], [4, 'text', null, 'de']] },
  });
  // the data cannot close its script element
  expect(out).toContain('<script type="application/json" id="sn-first-paint">{"l":{"locales":["en","de"],"storage":"locale"},"t":{"de":[[2,"attr","aria-label","Navigation \\u003c/script>"]');
  expect(locale).toBe('en');
});

test('several locales and no way to switch the helpers: what calls a helper or reads $locale waits for the page module', () => {
  const { body, data } = build(page('<b data-sn-text="m.brand()"></b><i data-sn-text="$locale"></i><s data-sn-text="here"></s>'),
    { locale: { locales: ['en', 'de'] } }, { m: { brand: () => 'Caley' } });
  expect(body).toContain('<b data-sn="1"></b><i data-sn="2"></i><s data-sn="3">/a/</s>');
  expect(data).toEqual({ l: { locales: ['en', 'de'] } });
});

test('the first-paint script is loaded before the page module when the page has first-paint data', () => {
  const html = page('<input type="checkbox" data-sn-state="{ on: false }" data-sn-model="on" data-sn-persist="on">');
  const out = compile(html, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} }, moduleSrc: '/page.js',
    firstPaint: { script: { src: '/assets/fp.js', attrs: { 'vite-ignore': '' } } },
  });
  expect(out.html).toContain('<script type="application/json" id="sn-first-paint">{"p":[[1,"on","checkbox"]]}</script><script src="/assets/fp.js" defer="" blocking="render" vite-ignore=""></script><script type="module" src="/page.js"></script>');
  const none = compile(page('<p></p>'), { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} }, firstPaint: { script: { src: '/fp.js' } } });
  expect(none.html).not.toContain('fp.js');
  expect(none.firstPaint).toBeNull();
});

test('without the firstPaint option the compiler writes nothing ahead', () => {
  const out = compile(page('<p data-sn-text="here"></p>'), { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } });
  expect(out.html).toContain('<p data-sn="1"></p>');
  expect(out.firstPaint).toBeUndefined();
});

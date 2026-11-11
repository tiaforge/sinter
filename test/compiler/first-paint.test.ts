// First paint at compile time: build-time constants written into the HTML, and what the early
// chunk renders.
import { expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/compile.js';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body data-sn-state="{ here: '/a/', at: $now }">${body}</body></html>`;

function build(html: string, helpers: Record<string, string[]> = {}, names: string[] = [], early: CompileOptions['early'] = { module: null }) {
  const namespaces: CompileOptions['helpers']['namespaces'] = {};
  for (const [ns, members] of Object.entries(helpers)) namespaces[ns] = { module: `/${ns}.js`, members };
  const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: '/h.js', names, namespaces }, prerender: true, early };
  const out = compile(html, opts);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  // the compiler's early IR, which the early module renders from compiled code (early-render.ts)
  const ir = compileParts(html, opts).early?.ir as any;
  return { html: out.html, body: out.html.slice(out.html.indexOf('<body')), early: out.early, ir };
}

test('build-time constants: literal state fields and constants, not helpers, resources or the clock', () => {
  const { body } = build(page(`
    <sn-resource name="user" src="/api/user"></sn-resource>
    <a href="/a/" data-sn-attr="{'aria-current': here === '/a/' ? 'page' : null, 'data-tooltip': m.mail()}"><span data-sn-text="m.mail()"></span></a>
    <a href="/b/" data-sn-attr="{'aria-current': here === '/b/' ? 'page' : null}">B</a>
    <p data-sn-text="user.name">…</p>
    <p data-sn-text="at">…</p>
    <p data-sn-show="here === '/b/'" data-sn-class="{on: here.length > 1}" data-sn-style="{'--w': 2 + 'px'}">x</p>
    <input type="checkbox" data-sn-model="flag" data-sn-state="{ flag: true }">
    <a data-sn-attr="{href: 'javascript:alert(1)', title: 'ok'}">c</a>
    <p data-sn-text="Math.random()">f</p>
    <template data-sn-if="here"><b data-sn-text="here"></b></template>`), { m: ['mail'] });
  expect(body).toContain('<a href="/a/" data-sn="1" aria-current="page"><span data-sn="2"></span></a>');
  expect(body).toContain('<a href="/b/" data-sn="3">B</a>');
  expect(body).toContain('<p data-sn="4">…</p>');
  expect(body).toContain('<p data-sn="5">…</p>');
  expect(body).toContain('<p data-sn="6" hidden="" class="on" style="--w: 2px">x</p>');
  expect(body).toContain('<input type="checkbox" data-sn="7" checked="">');
  expect(body).toContain('<a data-sn="8" title="ok">c</a>');
  expect(body).toContain('<p data-sn="9">f</p>');
  expect(body).toContain('<template data-sn="10"><b></b></template>');
});

test('the early module: the app\'s early module first, then the bindings that need no data, with only the helpers they call', () => {
  const { early, html } = build(page(`
    <sn-resource name="user" src="/api/user"></sn-resource>
    <nav data-sn-state="{ collapsed: false }" data-sn-attr="{'aria-label': m.nav()}">
      <input type="checkbox" data-sn-model="collapsed" data-sn-persist="nav-collapsed">
      <span data-sn-text="m.mail()"></span>
      <span data-sn-text="user.name + m.hello()"></span>
      <span data-sn-text="date(at)"></span>
      <span data-sn-text="fmt(here)"></span>
    </nav>`), { m: ['nav', 'mail', 'hello', 'unused'] }, ['fmt', 'other'], { module: '/src/sinter.early.ts', src: '/@sinter/early/index.html.js' });
  // the early runtime's parts the compiled renderer calls: the writers of the kinds it has, nothing else
  // (`aria-label` is no URL attribute: written without the browser's URL check)
  expect(early).toMatch(/^import "\/src\/sinter\.early\.ts";\nimport \{ run, \$k, byId, model, pm, set, st, text, w \} from '@tiaforge-ui\/sinter\/early';\nimport \{ fmt \} from "\/h\.js";\nimport \{ nav as m\$nav, mail as m\$mail \} from "\/m\.js";\n/);
  expect(early).not.toContain('hello');
  expect(early).not.toContain('user.name');
  expect(early).not.toContain('date(');
  // started by the early runtime: it renders once the document is parsed, and tells the page module
  expect(early).toContain('const page = () => {');
  // nothing to wait for (no early request, no messages): rendered in one step
  expect(early!.endsWith('run(page);\n')).toBe(true);
  // the early chunk loads render-blocking before the page module
  expect(html).toContain('<script type="module" src="/@sinter/early/index.html.js" blocking="render"></script><script type="module" src="/page.js"></script>');
});

test('early state: fields that need no data, persisted values, and the branch of a data-sn-if that reads them', () => {
  const { early, ir } = build(`<!doctype html><html data-sn-state="{ view: 'week' }" data-sn-persist="view"><head></head>
    <body data-sn-state="{ here: '/c/', week: monday($now), q: $url.q }">
      <template data-sn-if="view === 'week'"><div data-sn-text="here"></div><template data-sn-for="d in here.split('/')" data-sn-key="d"><i data-sn-text="d"></i></template></template>
      <template data-sn-else><p data-sn-text="week"></p></template>
      <template data-sn-if="q"><p>search</p></template>
    </body></html>`, {}, ['monday']);
  // state: `here` and the URL's `q` are known before data (the clock is not)
  expect(early).toContain('($) => ({ "here": (\'/c/\'), "q": ($.$url.q) })');
  expect(early).toContain('($) => ({ "view": (\'week\') })');
  expect(ir.roots.map((n: { tag: string; b: Array<{ k: string }> }) => [n.tag, n.b.map((b) => b.k)])).toEqual([['html', []], ['body', []], ['template', ['if']], ['template', ['else']], ['template', ['if']]]);
  expect(ir.roots[0].persist).toBe('view');
  // the if branch: its `here` text, not the row template inside it; the else branch: `week` is not known
  expect(ir.templates[0].nodes.map((n: { tag: string; path: number[] }) => [n.tag, n.path])).toEqual([['div', [0]]]);
  expect(ir.templates[2].nodes).toEqual([]);
  expect(early).not.toContain('monday');
  // compiled: the persisted state, the branch with its one text binding, no renderer for the empty else branch
  expect(early).toContain('s[0] = sp($, f[3], 0, "view");');
  // a node that opens no state has its ancestor's scope (no slot of its own): the template reads `$s1`'s
  expect(early).toContain('s[1] = st(s[0], f[4], 1); return s;');
  expect(early).toContain('w(n[2], f[0], s[1], (t, v) => iff(t, v, n[3], (ns, b) => { const n = [at(ns, [0], "div")]; w(n[0], f[1], b, text); }, 0, s[1]));');
  expect(early).toContain("import { run, $k, at, byId, iff, sp, st, text, w } from '@tiaforge-ui/sinter/early';");
});

test('no early module when nothing runs early and the app has no early module', () => {
  expect(build(page('<sn-resource name="u" src="/api/u?d={date(at)}"></sn-resource><p data-sn-text="u.x"></p>')).early).toBeNull();
  expect(build(page('<p data-sn-text="here"></p>'), {}, [], { module: '/src/sinter.early.ts' }).early).toBe('import "/src/sinter.early.ts";\nimport { start } from \'@tiaforge-ui/sinter/early\';\n\nstart(null, null);\n');
});

test('without the options the compiler writes nothing ahead and makes no early module', () => {
  const out = compile(page('<p data-sn-text="here"></p>'), { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } });
  expect(out.html).toContain('<p data-sn="1"></p>');
  expect(out.early).toBeUndefined();
});

test('early requests: resources whose URL reads only what is known early (state, persisted values, $now, $url, helpers); a URL fixed at build time is preloaded from the HTML', () => {
  const { early, html, ir } = build(`<!doctype html><html data-sn-state="{ view: 'week' }" data-sn-persist="view"><head></head>
    <body data-sn-state="{ week: monday($now), q: $url.q, sel: null }">
      <sn-resource name="user" src="/api/user"></sn-resource>
      <sn-resource name="days" src="/api/days?start={week}&q={q}" when="view === 'week'"></sn-resource>
      <sn-resource name="detail" src="/api/x/{sel.id}" when="sel"></sn-resource>
      <sn-resource name="dep" src="/api/y?u={user.id}"></sn-resource>
      <sn-resource name="pg" src="/api/p?u={user.id}" paginate="offset" page-size="10" key="id"></sn-resource>
      <sn-resource name="fmt" src="/api/z?d={date($now)}"></sn-resource>
      <p data-sn-text="dep.x"></p>
    </body></html>`, {}, ['monday']);
  // not: one that reads another resource (paginated or not), one that calls a built-in formatter
  expect(ir.res.map((r: { name: string }) => r.name)).toEqual(['days', 'detail']);
  // `user` is fixed at build time: a preload link in the head, first, and not requested again by the early file
  expect(html).toMatch(/<head><link rel="preload" as="fetch" crossorigin="" href="\/api\/user"><script/);
  expect(html.match(/rel="preload"/g)).toHaveLength(1);
  expect(ir.res[0]).toMatchObject({ src: ['/api/days?start=', expect.any(Number), '&q=', expect.any(Number)], when: expect.any(Number), scope: 1 });
  // the fields a request reads, the clock and the URL included (no binding shows them early)
  expect(early).toContain('"week": (monday($.$now))');
  expect(early).toContain('"q": ($.$url.q)');
  expect(early).toContain('import { monday } from "/h.js";');
  // the request machinery only on a page with early requests
  expect(early).toContain("import { start, $k, sp, st, requests } from '@tiaforge-ui/sinter/early';");
  // the requests read the root scopes the compiled `scopes` makes; there is nothing to render
  expect(early).toContain('render: () => {}');
  expect(early).toContain('ir: {"res":[');
  expect(early!.endsWith('start(page, null, requests());\n')).toBe(true);
});

test('early requests, paginated: the first page, with the query parameters the pager sends for it (page size, the `first` direction value, the page number in offset mode, no cursor); a literal `src` is preloaded at its first page', () => {
  const { early, html, ir } = build(`<!doctype html><html data-sn-state="{ box: 'inbox' }" data-sn-persist="box"><head></head>
    <body>
      <sn-resource name="user" src="/api/user"></sn-resource>
      <sn-resource name="mail" src="/api/mail?box={box}" key="id" paginate="keyset" page-size="50" size-param="limit" offset-param="offset" cursor="{after: id}" direction-param="dir" direction-values="{first: 'forward', prev: 'backward', next: 'forward', last: 'last'}" cache></sn-resource>
      <sn-resource name="pages" src="/api/pages?box={box}" key="id" paginate="offset" page-size="20" page-param="p" size-param="n"></sn-resource>
      <sn-resource name="more" src="/api/more?box={box}#x" key="id" paginate="append" page-size="5" cursor="{after: id}"></sn-resource>
      <sn-resource name="lit" src="/api/lit?a=1" key="id" paginate="keyset" page-size="10" cursor="{after: id}"></sn-resource>
      <sn-resource name="dep" src="/api/dep?u={user.id}" key="id" paginate="keyset" page-size="10" cursor="{after: id}"></sn-resource>
      <ul><template data-sn-for="x in mail"><li data-sn-text="x.id"></li></template></ul>
      <ul><template data-sn-for="x in pages"><li data-sn-text="x.id"></li></template></ul>
      <ul><template data-sn-for="x in more"><li data-sn-text="x.id"></li></template></ul>
      <ul><template data-sn-for="x in lit"><li data-sn-text="x.id"></li></template></ul>
      <ul><template data-sn-for="x in dep"><li data-sn-text="x.id"></li></template></ul>
    </body></html>`);
  // not `dep` (it reads another resource), not `lit` (preloaded from the HTML)
  expect(ir.res.map((r: { name: string; q: unknown }) => [r.name, r.q])).toEqual([
    ['mail', { limit: '50', dir: 'forward' }],
    ['pages', { p: '1', n: '20' }],
    ['more', { limit: '5', direction: 'first' }],
  ]);
  expect(html).toContain('<link rel="preload" as="fetch" crossorigin="" href="/api/lit?a=1&amp;limit=10&amp;direction=first">');
  expect(html.match(/rel="preload"/g)).toHaveLength(2);
  // the parameters are added as the runtime adds them; only a page with such a request imports that
  expect(early).toContain("import { start, $k, sp, requests, withParams } from '@tiaforge-ui/sinter/early';");
  expect(early!.endsWith('start(page, null, requests(withParams));\n')).toBe(true);
});

test('preconnect: every origin a literal resource or stream `src` names gets one `<link rel="preconnect" crossorigin>` (anonymous, as the runtime connects), before the preloads; such a `src` is no preload', () => {
  const { html } = build(page(`
    <sn-resource name="user" src="https://api.example.com/api/user"></sn-resource>
    <sn-resource name="tags" src="https://api.example.com/api/tags?x={here}"></sn-resource>
    <sn-resource name="local" src="/api/local"></sn-resource>
    <sn-sync src="https://events.example.com/stream"><sn-event name="e" resource="local" op="refetch"></sn-event></sn-sync>`));
  const head = html.slice(0, html.indexOf('<body'));
  expect(head.match(/<link rel="preconnect" href="([^"]+)" crossorigin="">/g)).toEqual([
    '<link rel="preconnect" href="https://api.example.com" crossorigin="">',
    '<link rel="preconnect" href="https://events.example.com" crossorigin="">',
  ]);
  expect(head.match(/rel="preload"/g)).toHaveLength(1);
  expect(head.indexOf('rel="preconnect"')).toBeLessThan(head.indexOf('rel="preload"'));
  // off with first paint
  const plain = compile(page('<sn-resource name="u" src="https://api.example.com/u"></sn-resource>'), { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } });
  expect(plain.html).not.toContain('preconnect');
});

test('early attributes: the URL check only where the expression does not fix the scheme', async () => {
  const { fixedScheme } = await import('../../src/compiler/early-render.js');
  for (const ok of [`($) => ('/article/' + $.a.slug)`, '($) => (`/p/${$.u}`)', `($) => ($.x ? '#top' : null)`, `($) => ($.on && '?q=' + $.q)`, `($) => ('https://cdn.example/' + $.f)`, `($) => ('./x' + $.y || '/home')`, `($) => ('.\\\\' + $.y)`, `($) => ('/a' + $.y)`])
    expect(fixedScheme(ok), ok).toBe(true);
  // a lone leading `/` does not count: `'/' + '/evil.com'` and `'/' + '\\evil.com'` are `//evil.com`, another origin
  for (const no of [`($) => ('/' + $.u)`, '($) => (`/${$.u}`)', `($) => ('/\\\\' + $.u)`, `($) => ('//' + $.u)`, `($) => ('/\t' + $.u)`, `($) => ($.x ? '/' + $.y : null)`])
    expect(fixedScheme(no), no).toBe(false);
  for (const no of [`($) => ($.a.url)`, `($) => (avatar($.a.image))`, `($) => ('' + $.u)`, '($) => (`${$.u}/x`)', `($) => ($.x ? '/a' : $.y)`, `($) => ('java' + 'script:x')`, `($) => ($.u + '/x')`])
    expect(fixedScheme(no), no).toBe(false);
  // persisted state: rendered early, not written into the HTML at build time
  const { early } = build(`<!doctype html><html><head></head><body data-sn-state="{ to: 'a' }" data-sn-persist="nav"><a data-sn-attr="{href: '/x/' + to, title: to}">a</a><img data-sn-attr="{src: to}" alt=""></body></html>`);
  expect(early).toContain('set, "href"');
  expect(early).toContain('set, "title"');
  expect(early).toContain('attr, "src"');
});

test('prototype baseMessages: a text binding that calls m is written in the base language and marked; it stays the browser\'s', () => {
  const html = page(`<div data-sn-state="{ who: 'Ada' }"><h1 data-sn-text="m.title()"></h1><p data-sn-text="m.hello({ name: who })"></p><a data-sn-attr="{title: m.title()}">x</a><p data-sn-text="m.gone()"></p></div>`);
  const opts: CompileOptions = {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', prerender: true, early: { module: null },
    helpers: { module: null, names: [], namespaces: { m: { module: '@tiaforge-ui/sinter/messages', members: ['title', 'hello', 'gone'] } } },
    baseMessages: { title: 'People', hello: 'Hello {name}' },
  };
  const out = compile(html, opts);
  const body = out.html.slice(out.html.indexOf('<body'));
  expect(body).toContain('data-sn-m="">People</h1>');
  expect(body).toContain('data-sn-m="">Hello Ada</p>');
  // attributes and unknown keys: left to the browser
  expect(body).not.toContain('title="People"');
  expect(body).toMatch(/<p data-sn="\d+"><\/p><\/div>/);
  // still rendered early, in the visitor's language
  expect(out.early).toContain('m$title');
});

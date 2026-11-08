// First paint at compile time: build-time constants written into the HTML, and what the early
// chunk renders.
import { expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body data-sn-state="{ here: '/a/', at: $now }">${body}</body></html>`;

function build(html: string, helpers: Record<string, string[]> = {}, names: string[] = [], early: CompileOptions['early'] = { module: null }) {
  const namespaces: CompileOptions['helpers']['namespaces'] = {};
  for (const [ns, members] of Object.entries(helpers)) namespaces[ns] = { module: `/${ns}.js`, members };
  const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: '/h.js', names, namespaces }, prerender: true, early };
  const out = compile(html, opts);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return { html: out.html, body: out.html.slice(out.html.indexOf('<body')), early: out.early };
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
  expect(early).toMatch(/^import "\/src\/sinter\.early\.ts";\nimport \{ start, \$k \} from '@tiaforge-ui\/sinter\/early';\nimport \{ fmt \} from "\/h\.js";\nimport \{ nav as m\$nav, mail as m\$mail \} from "\/m\.js";\n/);
  expect(early).not.toContain('hello');
  expect(early).not.toContain('user.name');
  expect(early).not.toContain('date(');
  // started by the early runtime: it renders once the document is parsed, and tells the page module
  expect(early).toContain('const page = () => {');
  expect(early!.endsWith('start(page, null);\n')).toBe(true);
  // the early chunk loads render-blocking before the page module
  expect(html).toContain('<script type="module" src="/@sinter/early/index.html.js" blocking="render"></script><script type="module" src="/page.js"></script>');
});

test('early state: fields that need no data, persisted values, and the branch of a data-sn-if that reads them', () => {
  const { early } = build(`<!doctype html><html data-sn-state="{ view: 'week' }" data-sn-persist="view"><head></head>
    <body data-sn-state="{ here: '/c/', week: monday($now), q: $url.q }">
      <template data-sn-if="view === 'week'"><div data-sn-text="here"></div><template data-sn-for="d in here.split('/')" data-sn-key="d"><i data-sn-text="d"></i></template></template>
      <template data-sn-else><p data-sn-text="week"></p></template>
      <template data-sn-if="q"><p>search</p></template>
    </body></html>`, {}, ['monday']);
  const ir = JSON.parse(/const ir = (.*);/.exec(early!)![1]!);
  // state: only `here` is known before data (the clock and the URL are not)
  expect(early).toContain('($) => ({ "here": (\'/c/\') })');
  expect(early).toContain('($) => ({ "view": (\'week\') })');
  expect(ir.roots.map((n: { tag: string; b: Array<{ k: string }> }) => [n.tag, n.b.map((b) => b.k)])).toEqual([['html', []], ['body', []], ['template', ['if']], ['template', ['else']]]);
  expect(ir.roots[0].persist).toBe('view');
  // the if branch: its `here` text, not the row template inside it; the else branch: `week` is not known
  expect(ir.templates[0].nodes.map((n: { tag: string; path: number[] }) => [n.tag, n.path])).toEqual([['div', [0]]]);
  expect(ir.templates[2].nodes).toEqual([]);
  expect(early).not.toContain('monday');
});

test('no early module when nothing runs early and the app has no early module', () => {
  expect(build(page('<sn-resource name="u" src="/api/u?d={date(at)}"></sn-resource><p data-sn-text="u.x"></p>')).early).toBeNull();
  expect(build(page('<p data-sn-text="here"></p>'), {}, [], { module: '/src/sinter.early.ts' }).early).toBe('import "/src/sinter.early.ts";\nimport { start, $k } from \'@tiaforge-ui/sinter/early\';\n\nconst page = () => {\n  const ir = {"roots":[{"tag":"body","p":-1,"b":[],"id":0,"sid":0,"state":1},{"tag":"p","p":0,"b":[{"k":"text","f":0}],"id":1}],"templates":[]};\n  const fns = [\n    ($) => ($.$s0.here),\n    ($) => ({ "here": (\'/a/\') }),\n  ];\n  return { ir, fns };\n};\nstart(page, null);\n');
});

test('without the options the compiler writes nothing ahead and makes no early module', () => {
  const out = compile(page('<p data-sn-text="here"></p>'), { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } });
  expect(out.html).toContain('<p data-sn="1"></p>');
  expect(out.early).toBeUndefined();
});

test('early requests: resources whose URL reads only what is known early (state, persisted values, $now, $url, helpers); a URL fixed at build time is preloaded from the HTML', () => {
  const { early, html } = build(`<!doctype html><html data-sn-state="{ view: 'week' }" data-sn-persist="view"><head></head>
    <body data-sn-state="{ week: monday($now), q: $url.q, sel: null }">
      <sn-resource name="user" src="/api/user"></sn-resource>
      <sn-resource name="days" src="/api/days?start={week}&q={q}" when="view === 'week'"></sn-resource>
      <sn-resource name="detail" src="/api/x/{sel.id}" when="sel"></sn-resource>
      <sn-resource name="dep" src="/api/y?u={user.id}"></sn-resource>
      <sn-resource name="pg" src="/api/p" paginate="offset" page-size="10" key="id"></sn-resource>
      <sn-resource name="fmt" src="/api/z?d={date($now)}"></sn-resource>
      <p data-sn-text="dep.x"></p>
    </body></html>`, {}, ['monday']);
  const ir = JSON.parse(/const ir = (.*);/.exec(early!)![1]!);
  // not: one that reads another resource, a paginated one, one that calls a built-in formatter
  expect(ir.res.map((r: { name: string }) => r.name)).toEqual(['days', 'detail']);
  // `user` is fixed at build time: a preload link in the head, first, and not requested again by the early file
  expect(html).toMatch(/<head><link rel="preload" as="fetch" crossorigin="" href="\/api\/user"><script/);
  expect(html.match(/rel="preload"/g)).toHaveLength(1);
  expect(ir.res[0]).toMatchObject({ src: ['/api/days?start=', expect.any(Number), '&q=', expect.any(Number)], when: expect.any(Number), scope: 1 });
  // the fields a request reads, the clock and the URL included (no binding shows them early)
  expect(early).toContain('"week": (monday($.$now))');
  expect(early).toContain('"q": ($.$url.q)');
  expect(early).toContain('import { monday } from "/h.js";');
});

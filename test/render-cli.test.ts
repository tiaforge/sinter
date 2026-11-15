// `sinter render`: the testing module's render() on the command line, over a project on disk
// (test/fixtures/render-app: a config module with request middleware, a helper, a component).
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { failed, formatReport, lineDiff, parseRenderArgs, pathMatches, renderPage, splitAssignment, type RenderArgs } from '../src/render-cli.js';

const root = resolve(__dirname, 'fixtures/render-app');
const args = (...argv: string[]) => {
  const a = parseRenderArgs(argv, root);
  if (typeof a === 'string') throw new Error(a);
  return a as RenderArgs;
};
const incident = (...more: string[]) => renderPage(args('incident.html', '--url', '/incidents/3', '--api', 'api.json', ...more));

test('requests with the headers the app\'s middleware adds, what rendered, and each resource\'s state', async () => {
  const r = await incident('--storage', 'ops.token=abc');
  expect(r.page).toBe('incident.html');
  expect(r.paths).toEqual(['/incidents/:id']);
  expect(r.urlMatches).toBe(true);
  expect(r.requests.map((q) => [q.method, q.url, q.headers.authorization, q.status, q.source])).toEqual([
    ['GET', '/api/me', 'Bearer abc', 200, 'mock'],
    ['GET', '/api/incidents/3', 'Bearer abc', 200, 'mock'],
  ]);
  // the helper and the component, from the project's files
  expect(r.rendered).toContain('<p class="who">ADA</p>');
  expect(r.rendered).toContain('<span class="badge" data-sn-c="status-badge">open</span>');
  // the resource has no `items`: the response's wrapper is its value, and the heading stays empty
  expect(r.rendered).toContain('<h1></h1>');
  const inc = r.resources.find((x) => x.name === 'incident')!;
  expect(inc.value).toEqual({ incident: { id: 3, title: 'Disk full' } });
  expect(inc.hint).toContain('items="incident"');
  const text = formatReport(r);
  expect(text).toMatch(/GET \/api\/me\s+Authorization: Bearer abc {2}→ 200 \(mock\)/);
  expect(text).toContain('← the value is the whole response');
});

test('steps: a select pushes a history entry, a click sends its action, Back restores the page', async () => {
  const r = await incident('--select', '#status=closed', '--click', '#close', '--back');
  const [select, click, back] = r.steps;
  expect(select!.history).toEqual([{ op: 'push', url: 'http://localhost/incidents/3?status=closed' }]);
  expect(select!.changed).toEqual([
    '-     <span class="badge" data-sn-c="status-badge">open</span>',
    '+     <span class="badge" data-sn-c="status-badge">closed</span>',
    '-     <select id="status">',
    '+     <select id="status" value="closed">',
  ]);
  expect(click!.requests.map((q) => `${q.method} ${q.url} ${q.status}`)).toEqual(['POST /api/incidents/3/close 204']);
  expect(back!.changed.join('\n')).toContain('+     <span class="badge" data-sn-c="status-badge">open</span>');
  expect(formatReport(r)).toContain('step --select #status=closed\n  history\n    push /incidents/3?status=closed');
});

test('a request no mock answers gets a 404 and is marked; a URL the page does not answer at is named', async () => {
  const r = await renderPage(args('incident.html', '--url', '/incident/3'));
  expect(r.urlMatches).toBe(false);
  expect(r.requests.every((q) => q.source === 'unmatched' && q.status === 404)).toBe(true);
  const text = formatReport(r);
  expect(text).toContain('← the page does not answer at this URL (it answers at /incidents/:id)');
  expect(text).toContain('(no mock)');
});

test('the exit code: 1 when a request had no mock or the page warned, 0 for a clean render', async () => {
  // the fixture's bindings read `incident.title` before the data arrives: the page warns
  expect(failed(await incident())).toBe(true);
  const unmatched = await renderPage(args('incident.html', '--url', '/incidents/3'));
  expect(unmatched.requests.some((q) => q.source === 'unmatched')).toBe(true);
  expect(failed(unmatched)).toBe(true);
  const r = await renderPage(args('clean.html', '--api', 'api.json'));
  expect([r.pageWarnings, failed(r)]).toEqual([0, false]);
});

test('the app\'s config is undone after a render, also one that fails', async () => {
  const { config } = await import('../src/runtime/config.js');
  const before = config.request.length;
  await incident();
  expect(config.request.length).toBe(before);
  await expect(renderPage(args('broken.html'))).rejects.toThrow();
  expect(config.request.length).toBe(before);
});

test('no wrapper hint for a resource with a `type`', async () => {
  const r = await renderPage(args('clean.html', '--api', 'api.json'));
  expect(r.resources.find((x) => x.name === 'me')!.hint).toBeUndefined();
});

test('storage: each key read is listed; a --storage key nothing read is a warning that names the keys read', async () => {
  const wrong = await incident('--storage', 'token=abc');
  expect(wrong.requests.every((q) => !q.headers.authorization)).toBe(true);
  expect(wrong.storage).toContainEqual({ area: 'local', key: 'ops.token', value: null });
  expect(wrong.warnings).toContain('--storage token: nothing read it; the page read `ops.token` (not set)');
  expect(formatReport(wrong)).toContain('storage\n  localStorage ops.token  (not set)');
  const right = await incident('--storage', 'ops.token=abc');
  expect(right.requests.every((q) => q.headers.authorization === 'Bearer abc')).toBe(true);
  expect(right.storage).toContainEqual({ area: 'local', key: 'ops.token', value: 'abc' });
  expect(right.warnings.some((w) => w.startsWith('--storage'))).toBe(false);
  expect(formatReport(right)).toContain('localStorage ops.token  = "abc"');
});

test('the stand-ins used are one line, and not a failure', async () => {
  const r = await renderPage(args('clean.html', '--api', 'api.json'));
  r.standIns = ['ResizeObserver (nothing is measured)'];
  expect(formatReport(r)).toContain('\njsdom stand-ins used: ResizeObserver (nothing is measured)\n');
  expect(failed(r)).toBe(false);
});

test('a step that cannot run stops the steps, with the reason', async () => {
  const r = await incident('--click', '#missing', '--back');
  expect(r.steps).toHaveLength(1);
  expect(r.steps[0]!.error).toBe('no element matches `#missing`');
  const s = await incident('--select', '#status=pending');
  expect(s.steps[0]!.error).toContain('has no option `pending`');
});

test('arguments', () => {
  expect(splitAssignment('#q=milk')).toEqual(['#q', 'milk']);
  expect(splitAssignment('[name="a=b"]=x=y')).toEqual(['[name="a=b"]', 'x=y']);
  expect(splitAssignment('input:not([type=x])=1')).toEqual(['input:not([type=x])', '1']);
  expect(splitAssignment('#q')).toBeNull();
  expect(parseRenderArgs(['a.html', 'b.html'], root)).toContain('one page at a time');
  expect(parseRenderArgs(['a.html', '--frob'], root)).toBe('unknown option --frob');
  expect(parseRenderArgs(['a.html', '--wait', 'soon'], root)).toContain('--wait takes a duration');
  const a = args('incident.html', '--api', 'api.json', '--api', 'http://localhost:3000', '--storage', 'k=v=w', '--wait', '5s', '--emit', 'x={"a":1}');
  expect([a.mocks, a.backends, a.storage]).toEqual([['api.json'], ['http://localhost:3000'], [['k', 'v=w']]]);
  expect(a.steps).toEqual([{ kind: 'wait', ms: 5000 }, { kind: 'emit', name: 'x', payload: { a: 1 } }]);
  expect(pathMatches(['/incidents/:id'], '/incidents/3')).toBe(true);
  expect(pathMatches(['/incidents/:id'], '/incidents/')).toBe(false);
  // a pattern also matches with a trailing slash (docs/static-pages.md)
  expect(pathMatches(['/incidents/:id'], '/incidents/3/')).toBe(true);
  expect(pathMatches(['/', '/index.html'], '/')).toBe(true);
  expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual(['- b', '+ x']);
});

test('a let that waits for a helper module that reaches a lazy package: rendered once it has loaded', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sinter-render-lazy-'));
  const put = (f: string, s: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), s); };
  try {
    put('package.json', '{"type":"module"}');
    put('vite.config.js', `import sinter from ${JSON.stringify(resolve(__dirname, '../src/vite.ts'))};\nexport default { plugins: [sinter({ lazy: ['fakelib'] })] };\n`);
    put('node_modules/fakelib/package.json', '{"name":"fakelib","type":"module","main":"index.js"}');
    put('node_modules/fakelib/index.js', 'export const twice = (s) => s + s;\n');
    put('src/sinter.helpers.js', "export * as crunch from './lib/crunch.js';\n");
    put('src/lib/crunch.js', "import { twice } from 'fakelib';\nexport function run(s) { return twice(s); }\n");
    put('index.html', '<!doctype html><html><head><title>x</title></head><body><main data-sn-state="{ s: \'ab\' }" data-sn-let="{ out: crunch.run(s) }"><p data-sn-text="out ?? \'…\'"></p></main></body></html>');
    const a = parseRenderArgs(['index.html'], dir);
    if (typeof a === 'string') throw new Error(a);
    const r = await renderPage(a as RenderArgs);
    expect(r.rendered).toContain('<p>abab</p>');
    // outside a let it is SN324: the helper module is known to reach the lazy package
    put('bad.html', '<!doctype html><html><head><title>x</title></head><body><p data-sn-state="{ s: \'ab\' }" data-sn-text="crunch.run(s)"></p></body></html>');
    const b = parseRenderArgs(['bad.html'], dir);
    if (typeof b === 'string') throw new Error(b);
    await expect(renderPage(b as RenderArgs)).rejects.toThrow(/SN324/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

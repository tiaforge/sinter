// `sinter render`: the testing module's render() on the command line, over a project on disk
// (test/fixtures/render-app: a config module with request middleware, a helper, a component).
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { formatReport, lineDiff, parseRenderArgs, pathMatches, renderPage, splitAssignment, type RenderArgs } from '../src/render-cli.js';

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
  expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual(['- b', '+ x']);
});

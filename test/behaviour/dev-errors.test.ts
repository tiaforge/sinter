// Dev builds: an expression that throws is reported at its own attribute, although identical code
// shares one function in the page's table, and the error itself follows (its stack, through the
// page module's source map, points at the expression).
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mockRequests, mockStream, render } from '../../src/testing/index.js';

let warn: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); error.mockRestore(); });
const said = (spy: typeof warn, part: string) => spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(part));

test('a binding that throws names its attribute, each use of shared code its own', async () => {
  // the same expression twice: one function in the table, two places
  const page = [
    '<div data-sn-state="{ a: null }">',
    '  <p data-sn-text="a.b"></p>',
    '  <span data-sn-text="a.b"></span>',
    '</div>',
  ].join('\n');
  await render(page);
  const calls = said(warn, 'threw');
  expect(calls.map((c: unknown[]) => c[0])).toEqual([
    expect.stringMatching(/^sinter: binding `text` on <p> at \/test\/page\.html:2:20 threw: /),
    expect.stringMatching(/^sinter: binding `text` on <span> at \/test\/page\.html:3:23 threw: /),
  ]);
  // the error follows, with its stack
  expect(calls[0]![1]).toBeInstanceOf(TypeError);
});

test('a model that cannot be set names its attribute', async () => {
  const r = await render('<div data-sn-state="{ a: null }">\n  <input data-sn-model="a.b"></div>');
  const input = r.root.querySelector('input')!;
  input.value = 'x';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await r.flush();
  const c = said(warn, 'could not be set')[0]!;
  expect(c[0]).toMatch(/^sinter: model on <input> at \/test\/page\.html:2:25 could not be set: /);
  expect(c[1]).toBeInstanceOf(TypeError);
});

test('a handler that throws names its attribute, each time it throws', async () => {
  const page = '<div data-sn-state="{ a: null }">\n  <button data-sn-on-click="a.b = 1">x</button>\n  <i data-sn-on-click="a.b = 1">y</i></div>';
  const r = await render(page);
  const [button, i] = [r.root.querySelector('button')!, r.root.querySelector('i')!];
  button.click(); button.click(); i.click();
  await r.flush();
  const calls = said(error, 'threw');
  expect(calls.map((c: unknown[]) => c[0])).toEqual([
    expect.stringMatching(/^sinter: handler at \/test\/page\.html:2:29 threw: /),
    expect.stringMatching(/^sinter: handler at \/test\/page\.html:2:29 threw: /),
    expect.stringMatching(/^sinter: handler at \/test\/page\.html:3:24 threw: /),
  ]);
  expect(calls[0]![1]).toBeInstanceOf(TypeError);
});

test('an action\'s `then` and a resource\'s `then` that throw name their attribute', async () => {
  const requests = mockRequests({ 'GET /api/items': { items: [] }, 'POST /api/items': {} });
  const page = [
    '<div data-sn-state="{ a: null }">',
    '  <sn-resource name="items" src="/api/items" items="items" key="id" then="a.b = 1"></sn-resource>',
    '  <button data-sn-post="/api/items" data-sn-then="a.b = 2">x</button>',
    '  <p data-sn-text="items.length"></p>',
    '</div>',
  ].join('\n');
  const r = await render(page, { requests });
  r.root.querySelector('button')!.click();
  await r.settle();
  const lines = page.split('\n'), col = (line: number, value: string) => lines[line - 1]!.indexOf(value) + 1;
  expect(said(error, 'threw').map((c: unknown[]) => String(c[0]).replace(/ threw: .*/, '')).sort()).toEqual([
    `sinter: handler at /test/page.html:2:${col(2, 'a.b = 1')}`,
    `sinter: handler at /test/page.html:3:${col(3, 'a.b = 2')}`,
  ]);
});

test('a stream event that cannot be applied and `page(…, \'last\')` without a total warn by code, with the same text', async () => {
  const stream = mockStream();
  const r = await render(`
    <sn-resource name="rows" src="/api/rows" key="id" paginate="offset" page-size="2"></sn-resource>
    <sn-sync src="/events">
      <sn-event name="patched" resource="rows" op="patch" set="{name}"></sn-event>
      <sn-event name="broken" resource="rows" op="upsert" item="a.b"></sn-event>
    </sn-sync>
    <template data-sn-for="x in rows"><li data-sn-text="x.id"></li></template>
    <button data-sn-on-click="page('rows', 'last')">last</button>`, {
    requests: mockRequests({ 'GET /api/rows?page=1&limit=2': [{ id: 1 }, { id: 2 }] }), streams: { '/events': stream },
  });
  await r.settle();
  stream.emit('patched', { name: 'x' });
  stream.emit('broken', {});
  r.root.querySelector('button')!.click();
  await r.settle();
  const w = r.warnings().map((x) => [x.code, x.message.replace(/applied: .*/, 'applied: …')]);
  expect(w).toContainEqual([29, 'sinter: event `patched` payload is missing key field(s) id for `rows`']);
  expect(w).toContainEqual([28, 'sinter: event `broken` could not be applied: …']);
  expect(w).toContainEqual([30, "sinter: page('rows', 'last') needs a known total"]);
  // the payload follows the message, as before
  expect(said(warn, 'missing key field(s)')[0]![1]).toEqual({ name: 'x' });
});

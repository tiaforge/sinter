import { afterEach, expect, test, vi } from 'vitest';
import { configure, SinterError } from '../../src/index.js';
import { createRequestLayer, TIMEOUT } from '../../src/runtime/request.js';
import { defaultEnv, type Env } from '../../src/runtime/env.js';
import { render, mockRequests } from '../../src/testing/index.js';

afterEach(() => { configure({ request: [], onError: null }); vi.restoreAllMocks(); });

test('load failures set $meta.error and dispatch sn-error with the resource', async () => {
  const requests = mockRequests({ 'GET /api/x': { status: 503, body: { message: 'down' } } });
  const { root, settle } = await render(`
    <sn-resource name="x" src="/api/x" key="id"></sn-resource>
    <div data-sn-state="{ r: '' }" data-sn-on-sn-error="r = $event.detail.resource; $event.preventDefault()">
      <p data-sn-text="$meta.x.error && $meta.x.error.status + ' ' + $meta.x.error.message"></p>
      <i data-sn-text="r"></i><b data-sn-text="x.length"></b>
    </div>`, { requests });
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('503 down');
});

test('reset() resets the nearest form and its models', async () => {
  const requests = mockRequests({ 'POST /api/x': null });
  const { root, settle } = await render(`
    <div data-sn-state="{ v: 'start' }">
      <form data-sn-post="/api/x" data-sn-then="reset()"><input name="v" value="start" data-sn-model="v"></form>
      <p data-sn-text="v"></p>
    </div>`, { requests });
  const input = root.querySelector('input')!;
  input.value = 'typed';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(input.value).toBe('start');
  expect(root.querySelector('p')!.textContent).toBe('start');
});

test('an <a> with a method attribute does not navigate', async () => {
  const requests = mockRequests({ 'POST /api/a': null });
  const { root, settle } = await render(`<a href="/elsewhere" data-sn-post="/api/a">go</a>`, { requests });
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  root.querySelector('a')!.dispatchEvent(ev);
  await settle();
  expect(ev.defaultPrevented).toBe(true);
  expect(requests.calls).toHaveLength(1);
});

test('a form with a file input is sent as multipart/form-data', async () => {
  const requests = mockRequests({ 'POST /api/up': null });
  const { root, settle } = await render(`<form data-sn-post="/api/up"><input name="t" value="x"><input type="file" name="f"></form>`, { requests });
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(requests.calls[0]!.headers['content-type']).toMatch(/multipart\/form-data/);
});

test('dev builds warn when state changes outside sinter', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { root, app, flush } = await render(`<div data-sn-state="{ n: 0 }"><p data-sn-text="n"></p><button data-sn-on-click="n++"></button></div>`);
  (app.state(root.querySelector('p')!).get() as { n: number }).n = 5;
  root.querySelector('button')!.click();
  await flush();
  expect(warn.mock.calls.some((c) => String(c[0]).includes('changed outside sinter: use `update()`'))).toBe(false);
  (app.state(root.querySelector('p')!).get() as { n: number }).n = 9;
  app.mark('$r.none');
  await flush();
  expect(warn.mock.calls.some((c) => String(c[0]).includes('state `n` changed outside sinter: use `update()`'))).toBe(true);
});

test('dev builds warn about duplicate keys and missing key fields', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const requests = mockRequests({ 'GET /api/x': [{ id: 1 }, { id: 1 }, { name: 'no id' }] });
  const { settle } = await render(`<sn-resource name="x" src="/api/x" key="id"></sn-resource><p data-sn-text="x.length"></p>`, { requests });
  await settle();
  const msgs = warn.mock.calls.map((c) => String(c[0]));
  expect(msgs.some((m) => m.includes('duplicate key `1`'))).toBe(true);
  expect(msgs.some((m) => m.includes('missing key field `id`'))).toBe(true);
});

function fakeEnv(fetch: Env['fetch']) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const env: Env = {
    ...defaultEnv, fetch, href: () => 'http://localhost/',
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  return { env, timers };
}

test('request layer: one retry for idempotent requests on network errors only', async () => {
  let n = 0;
  const { env } = fakeEnv(async () => { if (n++ === 0) throw new TypeError('net'); return new Response('{"ok":1}', { headers: { 'Content-Type': 'application/json' } }); });
  const layer = createRequestLayer(env, []);
  expect(await layer.send('/x')).toEqual({ ok: 1 });
  expect(n).toBe(2);

  n = 0;
  const post = createRequestLayer(fakeEnv(async () => { n++; throw new TypeError('net'); }).env, []);
  const err: SinterError = await post.send('/x', { method: 'POST', body: {} }).catch((e: SinterError) => e) as SinterError;
  expect(err).toBeInstanceOf(SinterError);
  expect([err.status, n]).toEqual([0, 1]);
});

test('request layer: 30 s timeout, parsed bodies and error shapes', async () => {
  const { env, timers } = fakeEnv((req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason))));
  const layer = createRequestLayer(env, []);
  const p = layer.send('/slow', { method: 'POST' }).catch((e: SinterError) => e) as Promise<SinterError>;
  await Promise.resolve();
  await Promise.resolve();
  expect(timers[0]!.ms).toBe(TIMEOUT);
  timers[0]!.fn();
  expect((await p).message).toBe('request timed out');

  const bad = createRequestLayer(fakeEnv(async () => new Response('{nope', { status: 200, headers: { 'Content-Type': 'application/json' } })).env, []);
  const e2: SinterError = await bad.send('/x').catch((e: SinterError) => e) as SinterError;
  expect([e2.status, e2.message]).toEqual([200, 'invalid JSON']);
  const empty = createRequestLayer(fakeEnv(async () => new Response(null, { status: 204 })).env, []);
  expect(await empty.send('/x')).toBeNull();
  const text = createRequestLayer(fakeEnv(async () => new Response('hi', { headers: { 'Content-Type': 'text/plain' } })).env, []);
  expect(await text.send('/x')).toBe('hi');
});

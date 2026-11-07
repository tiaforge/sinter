// @vitest-environment node
// Node's Request implements `keepalive` (happy-dom's does not).
import { expect, test } from 'vitest';
import { createRequestLayer } from '../src/runtime/request.js';
import { defaultEnv, type Env } from '../src/runtime/env.js';

test('mutations are sent with keepalive so a navigation cannot cancel them', async () => {
  const seen: Array<[string, boolean]> = [];
  const env: Env = {
    ...defaultEnv, href: () => 'http://localhost/', setTimeout: () => 0, clearTimeout: () => {},
    fetch: async (req) => { seen.push([req.method, req.keepalive]); return new Response(null, { status: 204 }); },
  };
  const layer = createRequestLayer(env, []);
  await layer.send('/x');
  await layer.send('/x', { method: 'POST', body: { a: 1 } });
  await layer.send('/x', { method: 'POST', body: { a: 'x'.repeat(70_000) } });
  expect(seen).toEqual([['GET', false], ['POST', true], ['POST', false]]);
});

test('the keepalive limit is measured in bytes, not characters', async () => {
  const seen: boolean[] = [];
  const env: Env = {
    ...defaultEnv, href: () => 'http://localhost/', setTimeout: () => 0, clearTimeout: () => {},
    fetch: async (req) => { seen.push(req.keepalive); return new Response(null, { status: 204 }); },
  };
  const layer = createRequestLayer(env, []);
  await layer.send('/x', { method: 'POST', body: { a: 'ä'.repeat(25_000) } });   // 50 KB of UTF-8
  await layer.send('/x', { method: 'POST', body: { a: 'ä'.repeat(40_000) } });   // 80 KB: over the limit
  expect(seen).toEqual([true, false]);
});

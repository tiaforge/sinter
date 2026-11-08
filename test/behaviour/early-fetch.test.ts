// Early requests: the early file starts the requests of resources whose URL is known before any
// data; the page module's request layer takes each response once, at the end of its middleware
// chain, when the request is the one the early file sent. Everything else fetches as before.
import { afterEach, expect, test } from 'vitest';
import { requests, start } from '../../src/early.js';
import { configure, header, onUnauthorized } from '../../src/runtime/config.js';
import { defaultEnv } from '../../src/runtime/env.js';
import { createRequestLayer } from '../../src/runtime/request.js';
import type { EarlyIR } from '../../src/ir.js';

const sent: Request[] = [];
const fetch = async (r: Request) => {
  sent.push(r);
  return r.url.endsWith('/gone') ? new Response('', { status: 401 }) : Response.json({ url: new URL(r.url).pathname + new URL(r.url).search });
};
const KEYS = ['sinter.prefetched', 'sinter.early.page'];
afterEach(() => {
  sent.length = 0;
  for (const k of KEYS) delete (globalThis as any)[Symbol.for(k)];
  configure({ env: defaultEnv });
});

/** The early file of a page whose state is `{ week }` and whose resources are given as URL templates over it. */
function earlyFile(res: Array<[string, Array<string | number>, number | null]>, fns: Array<(s: any) => unknown>) {
  const ir: EarlyIR = { roots: [{ tag: 'body', p: -1, b: [], id: 0, sid: 0, state: 0 }], templates: [], res: res.map(([name, src, when]) => ({ name, src, when, scope: 0 })) };
  start(() => ({ ir, fns: [() => ({ week: '2026-11-02', sel: null }), ...fns] }), null, requests());
}

test('a resource the early file requested is not requested again: the runtime takes its response', async () => {
  configure({ env: { ...defaultEnv, fetch } });
  earlyFile([['days', ['/api/days?start=', 1], null], ['detail', ['/api/x/', 2], 3]], [(s) => s.$s0.week, (s) => s.$s0.sel.id, (s) => s.$s0.sel]);
  // `detail`: its `when` is false early, so only `days` is requested
  expect(sent.map((r) => r.url)).toEqual(['http://localhost:3000/api/days?start=2026-11-02']);
  expect([...sent[0]!.headers].map(([k, v]) => [k.toLowerCase(), v])).toEqual([['accept', 'application/json']]);
  const req = createRequestLayer({ ...defaultEnv, fetch }, []);
  expect(await req.send('/api/days?start=2026-11-02')).toEqual({ url: '/api/days?start=2026-11-02' });
  expect(sent).toHaveLength(1);
  // once: a second request (a refetch) goes to the server
  await req.send('/api/days?start=2026-11-02');
  expect(sent).toHaveLength(2);
});

test('middleware: response middleware runs on the early response; a request middleware that changes the request gets a request of its own', async () => {
  configure({ env: { ...defaultEnv, fetch } });
  earlyFile([['gone', ['/api/gone'], null], ['days', ['/api/days'], null]], []);
  expect(sent).toHaveLength(2);
  let unauthorized = 0;
  const req = createRequestLayer({ ...defaultEnv, fetch }, [onUnauthorized(async (_, res) => { unauthorized++; return res; })]);
  await expect(req.send('/api/gone')).rejects.toMatchObject({ status: 401 });
  expect(unauthorized).toBe(1);
  expect(sent).toHaveLength(2);
  // a header added by middleware: the early response does not match, the request is sent again
  const withHeader = createRequestLayer({ ...defaultEnv, fetch }, [header('X-Sinter', '1')]);
  await withHeader.send('/api/days');
  expect(sent).toHaveLength(3);
  expect(sent[2]!.headers.get('X-Sinter')).toBe('1');
});

test('what no resource took is aborted after mount (sweep)', async () => {
  configure({ env: { ...defaultEnv, fetch } });
  earlyFile([['days', ['/api/days'], null]], []);
  const signal = sent[0]!.signal;
  expect(signal.aborted).toBe(false);
  (globalThis as any)[Symbol.for('sinter.prefetched')].sweep();
  expect(signal.aborted).toBe(true);
});

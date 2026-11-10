// Early requests of paginated resources: the early file requests the first page, exactly as the
// pager sends it (page size, the `first` direction value or page 1, no cursor), and the runtime's
// first load takes that response. `$meta` ends up as after a normal first load, and paging goes on
// from there. A request that is not the one the early file sent is sent by the runtime itself.
import { afterEach, expect, test } from 'vitest';
import { compile, earlyPage, type CompileOptions } from '../../src/compiler/index.js';
import { compileParts } from '../../src/compiler/compile.js';
import * as earlyExports from '../../src/early.js';
import { configured, requests, start, withParams } from '../../src/early.js';
import type { EarlyIR } from '../../src/ir.js';
import { configure, type Middleware } from '../../src/runtime/config.js';
import { defaultEnv } from '../../src/runtime/env.js';
import { memoryStorage, mockRequests, render, type MockRequests, type RecordedCall } from '../../src/testing/index.js';

const KEYS = ['sinter.prefetched', 'sinter.early.page'];
afterEach(() => {
  for (const k of KEYS) delete (globalThis as any)[Symbol.for(k)];
  configure({ env: defaultEnv });
});

const ALL = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
/** A keyset server over ALL (cursor `after`/`before`), and offset pages (`p`, `n`). */
function server(url: string) {
  const q = new URL(url, 'http://x').searchParams, n = Number(q.get('limit') ?? q.get('n'));
  if (q.has('p')) { const p = Number(q.get('p')); return { items: ALL.slice((p - 1) * n, p * n), total: ALL.length }; }
  const dir = q.get('dir');
  const page = dir === 'forward' && q.has('after') ? ALL.filter((m) => m.id > Number(q.get('after'))).slice(0, n)
    : dir === 'backward' ? ALL.filter((m) => m.id < Number(q.get('before'))).slice(-n)
    : dir === 'last' ? ALL.slice(-n) : ALL.slice(0, n);
  return { items: page, total: ALL.length };
}

const PAGE = (attrs: string) => `<!doctype html><html data-sn-state="{ box: 'inbox' }" data-sn-persist="box"><head></head><body>
  <sn-resource name="mail" src="/api/mail?box={box}" items="items" total="total" key="id" ${attrs}></sn-resource>
  <span data-sn-text="[$meta.mail.from, $meta.mail.to, $meta.mail.total, $meta.mail.pages, $meta.mail.hasPrev, $meta.mail.hasNext].join()"></span>
  <button id="next" data-sn-on-click="page('mail', 'next')"></button>
  <button id="prev" data-sn-on-click="page('mail', 'prev')"></button>
  <ul><template data-sn-for="m in mail"><li data-sn-text="m.id"></li></template></ul>
</body></html>`;
const KEYSET = `paginate="keyset" page-size="2" size-param="limit" offset-param="offset" cursor="{after: id, before: id}" direction-param="dir" direction-values="{first: 'forward', prev: 'backward', next: 'forward', last: 'last'}"`;

/**
 * A page load: the page's early file starts its requests (answered by the server, logged in
 * `early`), then the page module mounts. What the request layer does not take from the early file
 * reaches the mock (`net.calls`): the network of the page module.
 */
async function load(html: string, o: { storage?: Storage; session?: Storage; ir?: (ir: EarlyIR) => void; hold?: Promise<void> } = {}) {
  const opts: CompileOptions = { file: '/test/page.html', root: '/test', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null } };
  const out = compile(html, opts);
  // the early file's page object, as the compiler writes it
  const parts = compileParts(html, opts).early!;
  o.ir?.(parts.ir);
  const made = earlyPage(parts);
  // eslint-disable-next-line no-new-func -- the early file's function table and renderer
  const page = new Function('$k', ...made.uses, `"use strict"; const f = [${parts.fns.join(',\n')}]; return ${made.code};`)((x: unknown) => x, ...made.uses.map((u) => (earlyExports as Record<string, unknown>)[u]));
  const early: string[] = [];
  const storage = o.storage ?? memoryStorage();
  configure({ env: { ...defaultEnv, href: () => 'http://localhost/', storage: () => storage, fetch: async (r: Request) => { const u = new URL(r.url); early.push(u.pathname + u.search); await o.hold; return Response.json(server(r.url)); } } });
  expect(out.early).toContain(', requests(withParams)');
  start(() => page, null, requests(withParams, configured));
  const mock = mockRequests({ 'GET /api/mail': (c: RecordedCall) => server(c.url) });
  // the page module's requests: the early response if the request layer takes it, else the mock
  const net = ((req: Request, next: Parameters<Middleware>[1]) => next(req).catch((e: Error) => (/unexpected network request/.test(e.message) ? mock(req, next) : Promise.reject(e)))) as unknown as MockRequests;
  for (const k of ['calls', 'errors', 'pending', 'deliver'] as const) Object.defineProperty(net, k, { get: () => (typeof mock[k] == 'function' ? (mock[k] as () => unknown).bind(mock) : mock[k]) });
  const r = await render(html, { storage, ...(o.session ? { session: o.session } : {}), requests: net });
  const state = () => [[...r.root.querySelectorAll('li')].map((l) => l.textContent).join(','), r.root.querySelector('span')!.textContent];
  const go = async (id: string) => { r.root.querySelector<HTMLElement>(`#${id}`)!.click(); await r.settle(); };
  return { ...r, early, calls: mock.calls, state, go };
}

test('keyset: the early file requests the first page; the runtime takes it (no second request), $meta as after a normal first load; paging goes on', async () => {
  const storage = memoryStorage();
  storage.setItem('sn:box', JSON.stringify({ box: 'archive' }));
  const p = await load(PAGE(KEYSET), { storage });
  await p.settle();
  // the persisted view, the page size, the `first` direction value, no cursor or offset
  expect(p.early).toEqual(['/api/mail?box=archive&limit=2&dir=forward']);
  expect(p.calls).toEqual([]);
  expect(p.state()).toEqual(['1,2', '1,2,5,3,false,true']);
  await p.go('next');
  expect(p.calls.map((c) => c.url)).toEqual(['/api/mail?box=archive&after=2&before=2&limit=2&dir=forward']);
  expect(p.state()).toEqual(['3,4', '3,4,5,3,true,true']);
  await p.go('prev');
  expect(p.calls.at(-1)!.url).toBe('/api/mail?box=archive&after=3&before=3&limit=2&dir=backward');
  expect(p.state()).toEqual(['1,2', '1,2,5,3,false,true']);
});

test('offset: the early request is page 1 with the page size', async () => {
  const p = await load(PAGE('paginate="offset" page-size="2" page-param="p" size-param="n"'));
  await p.settle();
  expect(p.early).toEqual(['/api/mail?box=inbox&p=1&n=2']);
  expect(p.calls).toEqual([]);
  expect(p.state()).toEqual(['1,2', '1,2,5,3,false,true']);
  await p.go('next');
  expect(p.calls.map((c) => c.url)).toEqual(['/api/mail?box=inbox&p=2&n=2']);
  expect(p.state()).toEqual(['3,4', '3,4,5,3,true,true']);
});

test('an early request that is not the runtime\'s first page is not taken: the runtime requests the page itself', async () => {
  // as if the early file had built another page size
  const p = await load(PAGE(KEYSET), { ir: (ir) => { ir.res![0]!.q = { limit: '3', dir: 'forward' }; } });
  await p.settle();
  expect(p.early).toEqual(['/api/mail?box=inbox&limit=3&dir=forward']);
  expect(p.calls.map((c) => c.url)).toEqual(['/api/mail?box=inbox&limit=2&dir=forward']);
  expect(p.state()).toEqual(['1,2', '1,2,5,3,false,true']);
});

test('cache: the cached first page shows at once, the early response revalidates it', async () => {
  const session = memoryStorage();
  const first = await load(PAGE(`${KEYSET} cache`), { session });
  await first.settle();
  for (const k of KEYS) delete (globalThis as any)[Symbol.for(k)];
  ALL.push({ id: 0 });
  ALL.sort((a, b) => a.id - b.id);
  try {
    let answer!: () => void;
    const p = await load(PAGE(`${KEYSET} cache`), { session, hold: new Promise<void>((r) => { answer = r; }) });
    // the last page load's data, before the (early) response
    await p.flush();
    expect(p.state()).toEqual(['1,2', '1,2,5,3,false,true']);
    answer();
    await p.settle();
    expect(p.early).toEqual(['/api/mail?box=inbox&limit=2&dir=forward']);
    expect(p.calls).toEqual([]);
    expect(p.state()).toEqual(['0,1', '1,2,6,3,false,true']);
  } finally {
    ALL.shift();
  }
});

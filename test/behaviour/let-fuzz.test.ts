// @vitest-environment jsdom
// Cached lets against main's semantics (CONTRIBUTING.md, Fuzz tests). A let over a helper is computed once
// and kept until what it reads changes (lets.ts); a let without one is its expression, inlined at every read.
// Each case is one page twice: with lets over helpers (cached), and with each helper call written out as the
// expression it computes (inlined, the oracle). Random handlers mix writes in place and reassigned, store
// functions, refresh(), page() and an each resource, keyed rows moved, emit() with listeners that write and
// that read, a synchronous click on another element, an island whose prop setter fires an event in the middle
// of a flush, `<sn-sync>` upserts, refetches and a dropped stream, an optimistic action, actions whose then and
// catch read lets, a component's own let and a persisted scope, with reads of lets stored into state between
// all of them; the buttons are clicked in a
// random order, with and without a flush between. Every stored read and the page must agree, also after the
// early script's first paint is taken over.
import { expect, test } from 'vitest';
import { mockRequests, mockStream, render } from '../../src/testing/index.js';

/** how long the handlers and the click scripts get (`SN_FUZZ_DEPTH`, default 1) */
const DEPTH = Number(process.env.SN_FUZZ_DEPTH ?? 1);

/** a small seeded PRNG, so a failure names its case */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** the helpers, and the expression each call is when written out (the oracle) */
const HELPERS = {
  sum: (xs: number[]) => xs.reduce((p, q) => p + q, 0),
  pair: (a: number, n: number) => ({ v: a * 10 + n }),
  len: (o: { items: unknown[] }) => o.items.length,
  twice: (n: number) => n * 2,
  inc: (x: number) => x + 1,
};
const LETS: Array<[string, string, string]> = [
  ['T', 'sum(xs)', 'xs.reduce((p, q) => p + q, 0)'],
  ['P', 'pair(a, xs.length)', '({ v: a * 10 + xs.length })'],
  ['N', 'len(o)', 'o.items.length'],
  // a let that reads another
  ['TT', 'twice(T)', 'T * 2'],
  ['TS', 'sum(todos.map((t) => t.n))', 'todos.map((t) => t.n).reduce((p, q) => p + q, 0)'],
  // keyed rows, a page of a paginated resource, an each resource fanned out over todos
  ['KS', 'sum(ks.map((k) => k.n))', 'ks.map((k) => k.n).reduce((p, q) => p + q, 0)'],
  ['PG', 'sum(pg.map((x) => x.n))', 'pg.map((x) => x.n).reduce((p, q) => p + q, 0)'],
  ['EV', 'sum(ev.map((x) => x.n))', 'ev.map((x) => x.n).reduce((p, q) => p + q, 0)'],
];
const READS = ['T', 'P.v', 'N', 'TT', 'TS', 'T + N', 'P.v + TT', 'KS', 'PG', 'EV', 'KS + PG + EV'];
const OPS = [
  'a = a + 1', 'a = 7', 'xs.push(3)', 'xs = [...xs, 4]', 'xs.length && (xs[0] = xs[0] + 2)', 'xs.length > 1 && xs.pop()',
  'o.items.push(1)', 'o = { items: [...o.items, 2] }',
  'todos.length && patch(todos[0], { n: todos[0].n + 3 })', 'todos.length > 1 && remove(todos[todos.length - 1])', "upsert('todos', { id: 9, n: 90 })",
  "refresh('todos')", "emit('bump')", "emit('peek')", "$el.parentElement.querySelector('#x').click()", 'go = go + 1',
  // keyed rows moved, and moved then written through
  'ks = [...ks].reverse()', 'ks.length > 1 && (ks = [ks[ks.length - 1], ...ks.slice(0, -1)])', 'ks = [...ks].reverse(); ks[0].n = ks[0].n + 1',
  "page('pg', 2)", "page('pg', 1)", "refresh('ev')",
];

const ISLAND = 'x-pinger';
if (!customElements.get(ISLAND)) {
  customElements.define(ISLAND, class extends HTMLElement {
    // a prop set in the middle of a flush fires an event whose listener writes: a handler run mid-walk
    set n(v: number) { if (v > 0) this.dispatchEvent(new CustomEvent('ping', { bubbles: true })); }
  });
}

function page(r: () => number, oracle: boolean) {
  const call = (helper: string, written: string) => (oracle ? written : helper);
  const lets = LETS.map(([n, h, w]) => `${n}: ${call(h, w)}`).join(', ');
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  let reads = 0;
  const handlers = Array.from({ length: 3 }, () => {
    const ops: string[] = [];
    for (let i = 0, n = 2 + Math.floor(r() * (3 * DEPTH + 2)); i < n; i++) ops.push(r() < 0.4 ? `r${reads++} = ${pick(READS)}` : pick(OPS));
    return ops.join('; ');
  });
  const state = `{ a: 1, xs: [1, 2], o: { items: [1] }, ks: [{ id: 1, n: 1 }, { id: 2, n: 2 }, { id: 3, n: 3 }], go: 0, pk: null, th: null, ct: null, ${Array.from({ length: reads }, (_, i) => `r${i}: null`).join(', ')} }`;
  const html = `<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>
<sn-resource name="pg" src="/api/pg" items="items" total="total" key="id" paginate="offset" page-size="2"></sn-resource>
<sn-resource name="ev" each="t in todos" src="/api/ev?id={t.id}" key="id"></sn-resource>
<sn-sync src="/s"><sn-event name="upd" resource="todos" op="upsert"></sn-event><sn-event name="re" resource="todos" op="refetch"></sn-event></sn-sync>
<main data-sn-state="${state}" data-sn-let="{ ${lets} }" data-sn-on-bump="a = a + 10" data-sn-on-peek="pk = T + P.v" data-sn-on-ping="xs.length && (xs[0] = xs[0] + 5)">
  <${ISLAND} data-sn-prop="{ n: go }"></${ISLAND}>
  <p class="v" data-sn-text="[T, P.v, N, TT, TS].join(' ')"></p>
  <ul><template data-sn-for="x in xs"><li data-sn-let="{ R: ${call('inc(x)', 'x + 1')} }" data-sn-text="R + T"></li></template></ul>
  <c-v data-sn-prop="{ v: ${call('sum(xs)', 'xs.reduce((p, q) => p + q, 0)')} }"></c-v>
  <c-l data-sn-prop="{ xs }"></c-l>
  <ol><template data-sn-for="k in ks" data-sn-key="k.id"><li class="k" data-sn-let="{ KR: ${call('inc(k.n)', 'k.n + 1')} }" data-sn-text="k.id + ':' + KR + ':' + KS"></li></template></ol>
  <section data-sn-state="{ ps: 1, pr: null }" data-sn-persist="fz" data-sn-let="{ PS: ${call('twice(ps)', 'ps * 2')} }"><b class="ps" data-sn-text="PS + T"></b><button id="pp" data-sn-on-click="pr = PS; ps = ps + 1; pr = pr + PS"></button></section>
  <button id="ok" data-sn-post="/api/ok" data-sn-body="{}" data-sn-then="th = T + KS + TS"></button>
  <button id="bad" data-sn-post="/api/bad" data-sn-body="{}" data-sn-catch="ct = T + P.v + EV"></button>
  <button id="x" data-sn-on-click="a = a + 100"></button>
  <template data-sn-for="t in todos" data-sn-key="t.id"><button class="opt" data-sn-patch="/api/t" data-sn-body="{ id: t.id }" data-sn-optimistic="patch(t, { n: 50 })"></button></template>
  ${handlers.map((h, i) => `<button id="h${i}" data-sn-on-click="${h}"></button>`).join('\n  ')}
</main>`;
  return { html, handlers };
}
/** the components; `c-l` has a let of its own over a helper, written out for the oracle */
const components = (oracle: boolean) => ({
  'c-v': '<template data-sn-component="{ v: number }"><b class="cv" data-sn-text="v"></b></template>',
  'c-l': `<template data-sn-component="{ xs: number[] }"><div data-sn-let="{ C: ${oracle ? 'xs.reduce((p, q) => p + q, 0)' : 'sum(xs)'} }"><b class="cl" data-sn-text="C + ':' + xs.length"></b></div></template>`,
});
const PAGES = [{ id: 11, n: 1 }, { id: 12, n: 2 }, { id: 13, n: 3 }, { id: 14, n: 4 }, { id: 15, n: 5 }];
const requests = () => mockRequests({
  'GET /api/todos': [{ id: 1, n: 1 }, { id: 2, n: 2 }], 'PATCH /api/t': null, 'POST /api/ok': {}, 'POST /api/bad': { status: 500 },
  'GET /api/pg': (c) => { const q = new URL(c.url, 'http://x').searchParams, p = Number(q.get('page') ?? 1), n = Number(q.get('limit') ?? 2); return { items: PAGES.slice((p - 1) * n, p * n), total: PAGES.length }; },
  'GET /api/ev': (c) => { const id = Number(new URL(c.url, 'http://x').searchParams.get('id')); return [{ id: id * 100, n: id * 7 }]; },
});
/** a fresh storage per render: `data-sn-persist` writes into it */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => { m.delete(k); }, setItem: (k, v) => { m.set(k, String(v)); } };
}

/** what the user sees, the state the handlers stored, and what was persisted */
function seen(v: Awaited<ReturnType<typeof render>>, storage: Storage) {
  const main = v.root.querySelector('main')!, sec = main.querySelector('section')!;
  const text = (sel: string) => [...main.querySelectorAll(sel)].map((x) => x.textContent).join(',');
  return `${text('p.v')} | ${text('ul li')} | ${text('li.k')} | ${text('b.cv')} | ${text('b.cl')} | ${text('b.ps')} | ${JSON.stringify(v.state(main).get())} | ${JSON.stringify(v.state(sec).get())} | ${storage.getItem('sn:fz')}`;
}

const SEEDS = Number(process.env.SN_FUZZ_SEEDS ?? 150);

test('random handlers over cached lets: every read and the page agree with the lets written out (main\'s semantics)', async () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    // one script of steps for both pages: which button, whether to flush, whether a server message arrives
    const sr = rng(seed * 7919);
    // b: a handler (0-2), the optimistic action (3), the action that succeeds (4) or fails (5), the persisted scope's (6);
    // msg: an upsert (0-2), a refetch (3), the stream dropped and reconnected (4)
    const steps = Array.from({ length: 3 + Math.floor(sr() * (3 * DEPTH + 1)) }, () => ({ b: Math.floor(sr() * 7), flush: sr() < 0.6, msg: sr() < 0.3 ? Math.floor(sr() * 5) : -1 }));
    const early = seed % 3 === 0;
    const run = async (oracle: boolean) => {
      const { html } = page(rng(seed), oracle);
      const stream = mockStream();
      const storage = memoryStorage();
      const v = await render(html, { helpers: HELPERS, components: components(oracle), requests: requests(), streams: { '/s': stream }, storage, strict: false, ...(early && !oracle ? { firstPaint: true } : {}) });
      await v.settle();
      const main = v.root.querySelector('main')!;
      const out: string[] = [seen(v, storage)];
      for (const s of steps) {
        if (s.msg === 4) { stream.drop(); await v.settle(); }
        else if (s.msg >= 0 && stream.connected) s.msg === 3 ? stream.emit('re', null) : stream.emit('upd', { id: 1 + s.msg, n: 10 * (s.msg + 1) });
        main.querySelector<HTMLElement>(['#h0', '#h1', '#h2', '.opt', '#ok', '#bad', '#pp'][s.b]!)?.click();
        if (s.flush) { await v.settle(); out.push(seen(v, storage)); }
      }
      await v.settle();
      out.push(seen(v, storage));
      return { out, handlers: page(rng(seed), oracle).handlers };
    };
    try {
      const got = await run(false), want = await run(true);
      const at = got.out.findIndex((x, i) => x !== want.out[i]);
      if (at >= 0) failures.push(`seed ${seed} depth ${DEPTH}${early ? ' (early takeover)' : ''}: step ${at} of ${JSON.stringify(steps)}\n  handlers ${JSON.stringify(got.handlers)}\n  cached  ${got.out[at]}\n  inlined ${want.out[at]}`);
    } catch (e) {
      failures.push(`seed ${seed}: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`);
    }
  }
  expect(failures).toEqual([]);
}, 600_000);

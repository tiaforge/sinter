// @vitest-environment jsdom
// Cached lets against main's semantics (CONTRIBUTING.md, Fuzz tests). A let over a helper is computed once
// and kept until what it reads changes (lets.ts); a let without one is its expression, inlined at every read.
// Each case is one page twice: with lets over helpers (cached), and with each helper call written out as the
// expression it computes (inlined, the oracle). Random handlers mix writes in place and reassigned, store
// functions, refresh(), page() and an each resource, keyed rows moved, emit() with listeners that write and
// that read, a synchronous click on another element, an island whose prop setter fires an event in the middle
// of a flush, `<sn-sync>` upserts, refetches and a dropped stream, an optimistic action, actions whose then and
// catch read lets, a component's own let and a persisted scope, a plain object of primitives changed in place and
// replaced by an equal copy, rows keyed by index that a reorder gives other items, a row's own handler, an alias
// to a row's item, the locale under a namespace helper that reads it, and handlers that read after a nested one
// returns, with reads of lets stored into state between all of them (objects too: compared by structure, and
// by identity where the written-out let is an object of the page's own). The buttons are clicked in a random
// order, with and without a flush between. Every stored read and the page must agree, also after the early
// script's first paint is taken over; and the written-out page must be the same with the handlers' writes
// marked after they run, as main marks them.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { configure } from '../../src/index.js';
import type { App } from '../../src/runtime/app.js';
import { mockRequests, mockStream, render } from '../../src/testing/index.js';

/** how long the handlers and the click scripts get (`SN_FUZZ_DEPTH`, default 1) */
const DEPTH = Number(process.env.SN_FUZZ_DEPTH ?? 1);
/**
 * `SN_FUZZ_HELD=1` adds writes through an alias to a row's item (`sel = y`, then `sel.n = …`): the write marks
 * `sel.n`, not the row's, so a cached let over the row's item keeps its value until something it reads is
 * marked, where the written-out let is computed again whenever its binding runs (known, held: aliased state)
 */
const HELD = !!process.env.SN_FUZZ_HELD;

/** a small seeded PRNG, so a failure names its case */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** the locale a namespace helper reads itself, as an i18n library's messages do (configure({ locale })) */
let loc = 'en';

/** the helpers, and the expression each call is when written out (the oracle) */
const HELPERS = {
  sum: (xs: number[]) => xs.reduce((p, z) => p + z, 0),
  pair: (a: number, n: number) => ({ v: a * 10 + n }),
  len: (o: { items: unknown[] }) => o.items.length,
  twice: (n: number) => n * 2,
  inc: (x: number) => x + 1,
  area: (q: { w: number; h: number }) => q.w * q.h,
  // its argument, as it is: the written-out let is the state object itself
  same: (q: object) => q,
  tr: { word: (n: number) => (loc === 'de' ? 'zwei' : 'two') + n },
};
const LETS: Array<[string, string, string]> = [
  ['T', 'sum(xs)', 'xs.reduce((p, z) => p + z, 0)'],
  ['P', 'pair(a, xs.length)', '({ v: a * 10 + xs.length })'],
  ['N', 'len(o)', 'o.items.length'],
  // a let that reads another
  ['TT', 'twice(T)', 'T * 2'],
  ['TS', 'sum(todos.map((t) => t.n))', 'todos.map((t) => t.n).reduce((p, z) => p + z, 0)'],
  // keyed rows, a page of a paginated resource, an each resource fanned out over todos
  ['KS', 'sum(ks.map((k) => k.n))', 'ks.map((k) => k.n).reduce((p, z) => p + z, 0)'],
  ['PG', 'sum(pg.map((x) => x.n))', 'pg.map((x) => x.n).reduce((p, z) => p + z, 0)'],
  ['EV', 'sum(ev.map((x) => x.n))', 'ev.map((x) => x.n).reduce((p, z) => p + z, 0)'],
  // a plain object of primitives: changed in place, replaced by an equal copy; a result that is its argument
  ['Q', 'area(q)', 'q.w * q.h'],
  ['F', 'same(q)', 'q'],
  // rows that a row handler, a reorder and an alias change
  ['YS', 'sum(ys.map((y) => y.n))', 'ys.map((y) => y.n).reduce((p, z) => p + z, 0)'],
  // a namespace helper that reads the locale
  ['L', 'tr.word(a)', "($locale === 'de' ? 'zwei' : 'two') + a"],
];
const READS = ['T', 'P.v', 'N', 'TT', 'TS', 'T + N', 'P.v + TT', 'KS', 'PG', 'EV', 'KS + PG + EV',
  // an object stored as it is (compared by structure), and its identity where the written-out let is the state object
  'Q', 'F', 'F === q', 'F.w + Q', 'YS', 'L', 'L + Q'];
const OPS = [
  'a = a + 1', 'a = 7', 'xs.push(3)', 'xs = [...xs, 4]', 'xs.length && (xs[0] = xs[0] + 2)', 'xs.length > 1 && xs.pop()',
  'o.items.push(1)', 'o = { items: [...o.items, 2] }',
  'todos.length && patch(todos[0], { n: todos[0].n + 3 })', 'todos.length > 1 && remove(todos[todos.length - 1])', "upsert('todos', { id: 9, n: 90 })",
  "refresh('todos')", "emit('bump')", "emit('peek')", "$el.parentElement.querySelector('#x').click()", 'go = go + 1',
  // keyed rows moved, and moved then written through
  'ks = [...ks].reverse()', 'ks.length > 1 && (ks = [ks[ks.length - 1], ...ks.slice(0, -1)])', 'ks = [...ks].reverse(); ks[0].n = ks[0].n + 1',
  "page('pg', 2)", "page('pg', 1)", "refresh('ev')",
  'q.w = q.w + 1', 'q = { w: q.w, h: q.h }', 'q = { ...q, h: q.h + 1 }',
  'ys = [...ys].reverse()', 'ys.length > 1 && ys.shift()', 'ys.push({ n: ys.length + 5 })',
  "$locale = 'de'", "$locale = 'en'",
  // a nested handler (a synchronous click), then a read, a write and a read again in the outer one
  'NEST',
];
/** what a row's own handler does: through its item, the list it is in, an alias to its item */
const ROW_OPS = ['y.n = y.n + 1', 'sel = y', 'ys = [...ys].reverse()', 'ys.length > 1 && ys.shift()', 'q.w = q.w + 1', 'y.n = y.n + 1; ys = [...ys].reverse()',
  ...(HELD ? ['sel = y; sel.n = sel.n + 10'] : [])];
const ROW_READS = ['YR.v', 'YR.v + YS', 'YR.v + Q', 'YS + T'];
/** a write through the alias (`HELD` only) */
const ALIAS = 'sel && (sel.n = sel.n + 10)';

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
  // the same lets read before and after the outer handler's own writes, with the nested one returned in between
  const op = (o: string) => (o === 'NEST' ? `$el.parentElement.querySelector('#y').click(); r${reads++} = T + Q; xs.push(5); q.w = q.w + 1; r${reads++} = T + Q` : o);
  const handlers = Array.from({ length: 3 }, () => {
    const ops: string[] = [];
    for (let i = 0, n = 2 + Math.floor(r() * (3 * DEPTH + 2)); i < n; i++) ops.push(r() < 0.4 ? `r${reads++} = ${pick(READS)}` : op(pick(OPS)));
    if (HELD && r() < 0.25) ops.push(ALIAS);
    return ops.join('; ');
  });
  const rowOps: string[] = [];
  for (let i = 0, n = 2 + Math.floor(r() * (2 * DEPTH + 1)); i < n; i++) rowOps.push(r() < 0.45 ? `r${reads++} = ${pick(ROW_READS)}` : pick(ROW_OPS));
  const rowHandler = rowOps.join('; ');
  const state = `{ a: 1, xs: [1, 2], o: { items: [1] }, ks: [{ id: 1, n: 1 }, { id: 2, n: 2 }, { id: 3, n: 3 }], go: 0, pk: null, th: null, ct: null, q: { w: 2, h: 3 }, ys: [{ n: 1 }, { n: 2 }, { n: 3 }], sel: null, k2: 0, ${Array.from({ length: reads }, (_, i) => `r${i}: null`).join(', ')} }`;
  const html = `<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>
<sn-resource name="pg" src="/api/pg" items="items" total="total" key="id" paginate="offset" page-size="2"></sn-resource>
<sn-resource name="ev" each="t in todos" src="/api/ev?id={t.id}" key="id"></sn-resource>
<sn-sync src="/s"><sn-event name="upd" resource="todos" op="upsert"></sn-event><sn-event name="re" resource="todos" op="refetch"></sn-event></sn-sync>
<main data-sn-state="${state}" data-sn-let="{ ${lets} }" data-sn-on-bump="a = a + 10" data-sn-on-peek="pk = T + P.v" data-sn-on-ping="xs.length && (xs[0] = xs[0] + 5)">
  <${ISLAND} data-sn-prop="{ n: go }"></${ISLAND}>
  <p class="v" data-sn-text="[T, P.v, N, TT, TS].join(' ')"></p>
  <p class="f" data-sn-text="(F === q) + ' ' + F.w + ' ' + YS + ' ' + L"></p>
  <ul><template data-sn-for="x in xs"><li data-sn-let="{ R: ${call('inc(x)', 'x + 1')} }" data-sn-text="R + T"></li></template></ul>
  <c-v data-sn-prop="{ v: ${call('sum(xs)', 'xs.reduce((p, z) => p + z, 0)')} }"></c-v>
  <c-l data-sn-prop="{ xs }"></c-l>
  <ol><template data-sn-for="k in ks" data-sn-key="k.id"><li class="k" data-sn-let="{ KR: ${call('inc(k.n)', 'k.n + 1')} }" data-sn-text="k.id + ':' + KR + ':' + KS"></li></template></ol>
  <section data-sn-state="{ ps: 1, pr: null }" data-sn-persist="fz" data-sn-let="{ PS: ${call('twice(ps)', 'ps * 2')} }"><b class="ps" data-sn-text="PS + T"></b><button id="pp" data-sn-on-click="pr = PS; ps = ps + 1; pr = pr + PS"></button></section>
  <button id="ok" data-sn-post="/api/ok" data-sn-body="{}" data-sn-then="th = T + KS + TS"></button>
  <button id="bad" data-sn-post="/api/bad" data-sn-body="{}" data-sn-catch="ct = T + P.v + EV"></button>
  <button id="x" data-sn-on-click="a = a + 100"></button>
  <button id="y" data-sn-on-click="k2 = k2 + 1"></button>
  <button id="unalias" data-sn-on-click="sel = null"></button>
  <ol class="ys"><template data-sn-for="(y, i) in ys" data-sn-key="i"><li class="y" data-sn-let="{ YR: ${call('pair(y.n, i)', '({ v: y.n * 10 + i })')} }"><span data-sn-text="YR.v + ':' + Q + ':' + L"></span><button class="yb" data-sn-on-click="${rowHandler}"></button></li></template></ol>
  <template data-sn-for="t in todos" data-sn-key="t.id"><button class="opt" data-sn-patch="/api/t" data-sn-body="{ id: t.id }" data-sn-optimistic="patch(t, { n: 50 })"></button></template>
  ${handlers.map((h, i) => `<button id="h${i}" data-sn-on-click="${h}"></button>`).join('\n  ')}
</main>`;
  return { html, handlers: [...handlers, rowHandler] };
}
/** the components; `c-l` has a let of its own over a helper, written out for the oracle */
const components = (oracle: boolean) => ({
  'c-v': '<template data-sn-component="{ v: number }"><b class="cv" data-sn-text="v"></b></template>',
  'c-l': `<template data-sn-component="{ xs: number[] }"><div data-sn-let="{ C: ${oracle ? 'xs.reduce((p, z) => p + z, 0)' : 'sum(xs)'} }"><b class="cl" data-sn-text="C + ':' + xs.length"></b></div></template>`,
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
  return `${text('p.v')} | ${text('p.f')} | ${text('ul li')} | ${text('li.y span')} | ${text('li.k')} | ${text('b.cv')} | ${text('b.cl')} | ${text('b.ps')} | ${JSON.stringify(v.state(main).get())} | ${JSON.stringify(v.state(sec).get())} | ${storage.getItem('sn:fz')}`;
}

const SEEDS = Number(process.env.SN_FUZZ_SEEDS ?? 150);

/** the written-out page with the handlers' writes marked after they run, as main's `exec` marks them (this branch marks them first) */
function markAfter(app: App) {
  const exec = app.exec.bind(app);
  app.exec = (f, s, writes, o) => { exec(f, s, undefined, o); for (const w of writes ?? []) app.mark(w, s); };
}

test('the cached page compiles its lets to the cache; the written-out page has none', () => {
  const helpers = { module: '/src/sinter.helpers.ts', names: Object.keys(HELPERS).filter((k) => k !== 'tr'), namespaces: { tr: { module: '/src/sinter.helpers.ts', members: ['word'] } } };
  const out = (oracle: boolean) => compile(page(rng(1), oracle).html, { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: () => { throw new Error('none'); } }).module;
  // each page let, the row lets and the persisted scope's
  expect(out(false).split('$.$c(').length - 1).toBeGreaterThanOrEqual(LETS.length + 3);
  expect(out(true)).not.toContain('$.$c(');
});

test('random handlers over cached lets: every read and the page agree with the lets written out (main\'s semantics)', async () => {
  const failures: string[] = [];
  configure({ locale: { get: () => loc, set: (l) => { loc = l; } } });
  try {
    for (let seed = 1; seed <= SEEDS; seed++) {
      // one script of steps for both pages: which button, whether to flush, whether a server message arrives
      const sr = rng(seed * 7919);
      // b: a handler (0-2), the optimistic action (3), the action that succeeds (4) or fails (5), the persisted scope's (6),
      // a row's own handler (7, the row `row`); msg: an upsert (0-2), a refetch (3), the stream dropped and reconnected (4)
      const steps = Array.from({ length: 3 + Math.floor(sr() * (3 * DEPTH + 1)) }, () => ({ b: Math.floor(sr() * 8), row: Math.floor(sr() * 3), flush: sr() < 0.6, msg: sr() < 0.3 ? Math.floor(sr() * 5) : -1 }));
      const early = seed % 3 === 0;
      const run = async (oracle: boolean, after = false) => {
        loc = 'en';
        const { html } = page(rng(seed), oracle);
        const stream = mockStream();
        const storage = memoryStorage();
        const v = await render(html, { helpers: HELPERS, components: components(oracle), requests: requests(), streams: { '/s': stream }, storage, strict: false, ...(early && !oracle ? { firstPaint: true } : {}) });
        if (after) markAfter(v.app);
        await v.settle();
        const main = v.root.querySelector('main')!;
        const out: string[] = [seen(v, storage)];
        for (const s of steps) {
          if (s.msg === 4) { stream.drop(); await v.settle(); }
          else if (s.msg >= 0 && stream.connected) s.msg === 3 ? stream.emit('re', null) : stream.emit('upd', { id: 1 + s.msg, n: 10 * (s.msg + 1) });
          if (s.b === 7) main.querySelectorAll<HTMLElement>('.yb')[s.row]?.click();
          else main.querySelector<HTMLElement>(['#h0', '#h1', '#h2', '.opt', '#ok', '#bad', '#pp'][s.b]!)?.click();
          if (s.flush) { await v.settle(); out.push(seen(v, storage)); }
        }
        await v.settle();
        out.push(seen(v, storage));
        return { out, handlers: page(rng(seed), oracle).handlers };
      };
      try {
        const got = await run(false), want = await run(true), main = await run(true, true);
        const at = got.out.findIndex((x, i) => x !== want.out[i]);
        if (at >= 0) failures.push(`seed ${seed} depth ${DEPTH}${early ? ' (early takeover)' : ''}: step ${at} of ${JSON.stringify(steps)}\n  handlers ${JSON.stringify(got.handlers)}\n  cached  ${got.out[at]}\n  inlined ${want.out[at]}`);
        const am = want.out.findIndex((x, i) => x !== main.out[i]);
        if (am >= 0) failures.push(`seed ${seed} depth ${DEPTH}: the written-out page, writes marked first and after (main), step ${am} of ${JSON.stringify(steps)}\n  handlers ${JSON.stringify(got.handlers)}\n  first ${want.out[am]}\n  after ${main.out[am]}`);
      } catch (e) {
        failures.push(`seed ${seed}: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`);
      }
    }
  } finally { configure({ locale: null }); loc = 'en'; }
  if (process.env.SN_FUZZ_OUT) (await import('node:fs')).writeFileSync(process.env.SN_FUZZ_OUT, failures.join('\n\n'));
  expect(failures).toEqual([]);
}, 600_000);

// @vitest-environment jsdom
// Reactivity under random handlers (CONTRIBUTING.md, Fuzz tests). Random handlers over a page with lets over
// helpers mix writes in place and reassigned, store functions, refresh(), page() and an each resource, keyed rows
// moved, rows keyed by index that a reorder gives other items and their own handlers, emit() with listeners that
// write and that read, a synchronous click on another element (a nested handler, read around), an island whose
// prop setter fires an event in the middle of a flush, `<sn-sync>` upserts, refetches and a dropped stream, an
// optimistic action, actions whose then and catch read lets, a component's own let and a persisted scope, a plain
// object of primitives changed in place and replaced by an equal copy, the locale, with reads of lets stored into
// state between all of them; the buttons are clicked in a random order, with and without a flush between. Three
// oracles:
// - memo(): the same page with every helper wrapped in memo() gives the same page, state and stored reads, by
//   structure (a memoized result is a frozen copy);
// - the truth: after each settle, every state scope marked whole changes nothing on the page (a write path that
//   marks too little shows here, lets or not);
// - the first paint: on a third of the seeds the memoized page is the early script's first paint taken over.
// Writes through an alias (`sel = y; sel.n += 10`) are main's known gap (a write marks the alias's path, not the
// item's): `SN_FUZZ_ALIAS=1` turns them on; they come on by default with the alias tracking (its own PR).
import { expect, test } from 'vitest';
import { configure } from '../../src/index.js';
import { memo } from '../../src/memo.js';
import { mockRequests, mockStream, render } from '../../src/testing/index.js';
import { reset as resetCore } from '../core-flags.js';

/** how long the handlers and the click scripts get (`SN_FUZZ_DEPTH`, default 1) */
const DEPTH = Number(process.env.SN_FUZZ_DEPTH ?? 1);
/** writes through aliases (`SN_FUZZ_ALIAS=1`): see above */
const ALIASES = !!process.env.SN_FUZZ_ALIAS;

/** a small seeded PRNG, so a failure names its case */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** the locale (configure({ locale })), which a memoized helper takes as an argument */
let loc = 'en';

/** the helpers; each is memoized for the other page */
const HELPERS = {
  sum: (xs: number[]) => xs.reduce((p, z) => p + z, 0),
  pair: (a: number, n: number) => ({ v: a * 10 + n }),
  len: (o: { items: unknown[] }) => o.items.length,
  twice: (n: number) => n * 2,
  inc: (x: number) => x + 1,
  area: (q: { w: number; h: number }) => q.w * q.h,
  // a result that holds its argument (memo() copies it first: never the state object)
  wrap: (q: { w: number; h: number }) => ({ q, a: q.w * q.h }),
  // an element of its argument (an object list: memo() calls through)
  at: (xs: unknown[], i: number) => xs[i],
  // a list of objects: memo() calls through, every time
  big: (ys: Array<{ n: number }>) => ys.filter((y) => y.n > 1).length,
  // the locale is an argument, as a memoized function's must be
  tr: { word: (n: number, l: string) => (l === 'de' ? 'zwei' : 'two') + n },
};
const MEMOIZED = {
  ...Object.fromEntries(Object.entries(HELPERS).filter(([k]) => k !== 'tr').map(([k, f]) => [k, memo(f as (...a: never[]) => unknown, { maxSize: 4096 })])),
  tr: { word: memo(HELPERS.tr.word) },
};
const LETS: Array<[string, string]> = [
  ['T', 'sum(xs)'], ['P', 'pair(a, xs.length)'], ['N', 'len(o)'],
  // a let that reads another
  ['TT', 'twice(T)'], ['TS', 'sum(todos.map((t) => t.n))'],
  // keyed rows, a page of a paginated resource, an each resource fanned out over todos
  ['KS', 'sum(ks.map((k) => k.n))'], ['PG', 'sum(pg.map((x) => x.n))'], ['EV', 'sum(ev.map((x) => x.n))'],
  // a plain object of primitives: changed in place, replaced by an equal copy; a result that holds it
  ['Q', 'area(q)'], ['W', 'wrap(q)'],
  // rows that a row handler and a reorder change
  ['YS', 'sum(ys.map((y) => y.n))'],
  // memo()'s call-through path (an argument it does not key)
  ['BG', 'big(ys)'],
  ['L', 'tr.word(a, $locale)'],
  // over what each alias holds (`SN_FUZZ_ALIAS`)
  ['SL', 'twice(sel ? sel.n : 0)'], ['BL', 'twice(box ? box.it.n : 0)'], ['AL', 'sum(arr.map((x) => x.n))'], ['HL', 'twice(h ? h.n : 0)'], ['UL', 'twice(u ? u.n : 0)'],
];
const READS = ['T', 'P.v', 'N', 'TT', 'TS', 'T + N', 'P.v + TT', 'KS', 'PG', 'EV', 'KS + PG + EV', 'YS + SL', 'BL + YS', 'AL + YS', 'HL + UL + YS',
  'Q', 'W.a + W.q.w', 'YS', 'L', 'L + Q'];
const OPS = [
  // a memoized result is frozen and shared: a handler keeps a copy of one and changes the copy
  'cw = structuredClone(W); cw.a = cw.a + 1; cw.q.w = cw.q.w + 5', 'cp = structuredClone(P); cp.v = cp.v * 2',
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
const ROW_OPS = ['y.n = y.n + 1', 'ys = [...ys].reverse()', 'ys.length > 1 && ys.shift()', 'q.w = q.w + 1', 'y.n = y.n + 1; ys = [...ys].reverse()',
  // aliases to the row's item (`SN_FUZZ_ALIAS`): a write through one in the same handler, stored inside another object, pushed to another list
  ...(ALIASES ? ['sel = y', 'sel = y; sel.n = sel.n + 10', 'box = { it: y }', 'arr.push(y)'] : [])];
const ROW_READS = ['YR.v', 'YR.v + YS', 'YR.v + Q', 'YS + T'];
/** aliases made from the page (a helper's element, `reduce()`), and writes through each kind (`SN_FUZZ_ALIAS`) */
const ALIAS = ['sel && (sel.n = sel.n + 10)', 'box && (box.it.n = box.it.n + 3)', 'arr.length && (arr[arr.length - 1].n = arr[arr.length - 1].n + 4)',
  'box = ys.length ? { it: ys[ys.length - 1] } : null',
  // one field per kind, so that each rule is what keeps it right: `h` a helper's element, `u` one from reduce()
  // writes through the list itself, which reach every alias of its rows the other way round
  'ys.length && (ys[0].n = ys[0].n + 2)', 'ys.forEach((y) => (y.n = y.n + 1))', 'sel = ys.length ? ys[ys.length - 1] : null',
  'h = at(ys, 1) ?? null', 'h && (h.n = h.n + 5)',
  'u = ys.length ? ys.reduce((p, y) => (y.n > p.n ? y : p), ys[0]) : null', 'u && (u.n = u.n + 7)',
  'u = ys.length ? ys.reduce((p, y) => (y.n > p.n ? y : p), ys[0]) : null; u && (u.n = u.n + 7)', 'h = at(ys, 0) ?? null; h && (h.n = h.n + 5)',
  // an untraceable alias, then a change through another name: what reads it must see it
  'u = ys.length ? ys.reduce((p, y) => (y.n > p.n ? y : p), ys[0]) : null; ys.forEach((y) => (y.n = y.n + 1))', 'sel && (sel.n = sel.n + 1); h && (h.n = h.n + 1)'];

const ISLAND = 'x-pinger';
if (!customElements.get(ISLAND)) {
  customElements.define(ISLAND, class extends HTMLElement {
    // a prop set in the middle of a flush fires an event whose listener writes: a handler run mid-walk
    set n(v: number) { if (v > 0) this.dispatchEvent(new CustomEvent('ping', { bubbles: true })); }
  });
}

function page(r: () => number) {
  const lets = LETS.map(([n, e]) => `${n}: ${e}`).join(', ');
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  let reads = 0;
  // the same lets read before and after the outer handler's own writes, with the nested one returned in between
  const op = (o: string) => (o === 'NEST' ? `$el.parentElement.querySelector('#y').click(); r${reads++} = T + Q; xs.push(5); q.w = q.w + 1; r${reads++} = T + Q` : o);
  const handlers = Array.from({ length: 3 }, () => {
    const ops: string[] = [];
    for (let i = 0, n = 2 + Math.floor(r() * (3 * DEPTH + 2)); i < n; i++) ops.push(r() < 0.4 ? `r${reads++} = ${pick(READS)}` : op(pick(OPS)));
    if (ALIASES && r() < 0.35) ops.push(pick(ALIAS));
    return ops.join('; ');
  });
  // a handler of aliases only: made, written through either name, read (without aliases: one more of the others)
  const aliasOps: string[] = [];
  for (let i = 0, n = 3 + Math.floor(r() * (2 * DEPTH + 2)); i < n; i++) aliasOps.push(r() < 0.3 ? `r${reads++} = ${pick(READS.slice(-4))}` : ALIASES ? pick(ALIAS) : op(pick(OPS)));
  handlers.push(aliasOps.join('; '));
  const rowOps: string[] = [];
  for (let i = 0, n = 2 + Math.floor(r() * (2 * DEPTH + 1)); i < n; i++) rowOps.push(r() < 0.45 ? `r${reads++} = ${pick(ROW_READS)}` : pick(ROW_OPS));
  const rowHandler = rowOps.join('; ');
  const state = `{ a: 1, xs: [1, 2], o: { items: [1] }, ks: [{ id: 1, n: 1 }, { id: 2, n: 2 }, { id: 3, n: 3 }], go: 0, pk: null, th: null, ct: null, q: { w: 2, h: 3 }, ys: [{ n: 1 }, { n: 2 }, { n: 3 }], sel: null, box: null, arr: [], h: null, u: null, k2: 0, cw: null, cp: null, ${Array.from({ length: reads }, (_, i) => `r${i}: null`).join(', ')} }`;
  const html = `<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>
<sn-resource name="pg" src="/api/pg" items="items" total="total" key="id" paginate="offset" page-size="2"></sn-resource>
<sn-resource name="ev" each="t in todos" src="/api/ev?id={t.id}" key="id"></sn-resource>
<sn-sync src="/s"><sn-event name="upd" resource="todos" op="upsert"></sn-event><sn-event name="re" resource="todos" op="refetch"></sn-event></sn-sync>
<main data-sn-state="${state}" data-sn-let="{ ${lets} }" data-sn-on-bump="a = a + 10" data-sn-on-peek="pk = T + P.v" data-sn-on-ping="xs.length && (xs[0] = xs[0] + 5)">
  <${ISLAND} data-sn-prop="{ n: go }"></${ISLAND}>
  <p class="v" data-sn-text="[T, P.v, N, TT, TS].join(' ')"></p>
  <p class="f" data-sn-text="W.q.w + ' ' + W.a + ' ' + YS + ' ' + L + ' ' + BG + ' ' + (cw ? cw.a + cw.q.w : '-') + ' ' + (cp ? cp.v : '-')"></p>
  <p class="al"><i data-sn-text="SL"></i> <i data-sn-text="BL"></i> <i data-sn-text="AL"></i> <i data-sn-text="HL"></i> <i data-sn-text="UL"></i> <i data-sn-text="YS"></i></p>
  <ul><template data-sn-for="x in xs"><li data-sn-let="{ R: inc(x) }" data-sn-text="R + T"></li></template></ul>
  <c-v data-sn-prop="{ v: sum(xs) }"></c-v>
  <c-l data-sn-prop="{ xs }"></c-l>
  <ol><template data-sn-for="k in ks" data-sn-key="k.id"><li class="k" data-sn-let="{ KR: inc(k.n) }" data-sn-text="k.id + ':' + KR + ':' + KS"></li></template></ol>
  <section data-sn-state="{ ps: 1, pr: null }" data-sn-persist="fz" data-sn-let="{ PS: twice(ps) }"><b class="ps" data-sn-text="PS + T"></b><button id="pp" data-sn-on-click="pr = PS; ps = ps + 1; pr = pr + PS"></button></section>
  <button id="ok" data-sn-post="/api/ok" data-sn-body="{}" data-sn-then="th = T + KS + TS"></button>
  <button id="bad" data-sn-post="/api/bad" data-sn-body="{}" data-sn-catch="ct = T + P.v + EV"></button>
  <button id="x" data-sn-on-click="a = a + 100"></button>
  <button id="y" data-sn-on-click="k2 = k2 + 1"></button>
  <button id="unalias" data-sn-on-click="sel = null; box = null; arr = []; h = null; u = null"></button>
  <ol class="ys"><template data-sn-for="(y, i) in ys" data-sn-key="i"><li class="y" data-sn-let="{ YR: pair(y.n, i) }"><span data-sn-text="YR.v + ':' + Q + ':' + L"></span><button class="yb" data-sn-on-click="${rowHandler}"></button></li></template></ol>
  <template data-sn-for="t in todos" data-sn-key="t.id"><button class="opt" data-sn-patch="/api/t" data-sn-body="{ id: t.id }" data-sn-optimistic="patch(t, { n: 50 })"></button></template>
  ${handlers.map((h, i) => `<button id="h${i}" data-sn-on-click="${h}"></button>`).join('\n  ')}
</main>`;
  return { html, handlers: [...handlers, rowHandler] };
}
/** the components; `c-l` has a let of its own over a helper */
const COMPONENTS = {
  'c-v': '<template data-sn-component="{ v: number }"><b class="cv" data-sn-text="v"></b></template>',
  'c-l': '<template data-sn-component="{ xs: number[] }"><div data-sn-let="{ C: sum(xs) }"><b class="cl" data-sn-text="C + \':\' + xs.length"></b></div></template>',
};
const PAGES = [{ id: 11, n: 1 }, { id: 12, n: 2 }, { id: 13, n: 3 }, { id: 14, n: 4 }, { id: 15, n: 5 }];
/** the mocked API */
const requests = () => {
  const routes: Record<string, unknown> = {
    'GET /api/todos': [{ id: 1, n: 1 }, { id: 2, n: 2 }], 'PATCH /api/t': null, 'POST /api/ok': {}, 'POST /api/bad': { status: 500 },
    'GET /api/pg': (c: { url: string }) => { const q = new URL(c.url, 'http://x').searchParams, p = Number(q.get('page') ?? 1), n = Number(q.get('limit') ?? 2); return { items: PAGES.slice((p - 1) * n, p * n), total: PAGES.length }; },
    'GET /api/ev': (c: { url: string }) => { const id = Number(new URL(c.url, 'http://x').searchParams.get('id')); return [{ id: id * 100, n: id * 7 }]; },
  };
  return mockRequests(routes as Parameters<typeof mockRequests>[0]);
};
/** a fresh storage per render: `data-sn-persist` writes into it */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => { m.delete(k); }, setItem: (k, v) => { m.set(k, String(v)); } };
}

/** what the user sees, the state the handlers stored, and what was persisted */
function seen(v: Awaited<ReturnType<typeof render>>, storage: Storage) {
  const main = v.root.querySelector('main')!, sec = main.querySelector('section')!;
  const text = (sel: string) => [...main.querySelectorAll(sel)].map((x) => x.textContent).join(',');
  return `${text('p.v')} | ${text('p.f')} | ${text('p.al')} | ${text('ul li')} | ${text('li.y span')} | ${text('li.k')} | ${text('b.cv')} | ${text('b.cl')} | ${text('b.ps')} | ${JSON.stringify(v.state(main).get())} | ${JSON.stringify(v.state(sec).get())} | ${storage.getItem('sn:fz')}`;
}

const SEEDS = Number(process.env.SN_FUZZ_SEEDS ?? 150);
/** the first seed (`SN_FUZZ_FIRST`, default 1): a long sweep runs in chunks, side by side */
const FIRST = Number(process.env.SN_FUZZ_FIRST ?? 1);

test('random handlers: the page with memoized helpers agrees with the plain one, every scope marked whole changes nothing, and so after the takeover', async () => {
  const failures: string[] = [];
  configure({ locale: { get: () => loc, set: (l) => { loc = l; } } });
  try {
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
      // each seed on the smallest core for its page (test/core-flags.ts)
      resetCore();
      // one script of steps for both pages: which button, whether to flush, whether a server message arrives
      const sr = rng(seed * 7919);
      // b: a handler (0-2), the optimistic action (3), the action that succeeds (4) or fails (5), the persisted scope's (6),
      // a row's own handler (7, the row `row`); msg: an upsert (0-2), a refetch (3), the stream dropped and reconnected (4)
      const steps = Array.from({ length: 3 + Math.floor(sr() * (3 * DEPTH + 1)) }, () => ({ b: Math.floor(sr() * 10), row: Math.floor(sr() * 3), flush: sr() < 0.6, msg: sr() < 0.3 ? Math.floor(sr() * 5) : -1 }));
      const early = seed % 3 === 0;
      const stale: string[] = [];
      const run = async (memoized: boolean) => {
        loc = 'en';
        for (const f of Object.values(MEMOIZED)) (f as { clear?: () => void }).clear?.();
        MEMOIZED.tr.word.clear();
        const { html } = page(rng(seed));
        const stream = mockStream();
        const storage = memoryStorage();
        const v = await render(html, { helpers: memoized ? MEMOIZED : HELPERS, components: COMPONENTS, requests: requests(), streams: { '/s': stream }, storage, strict: false, ...(early && memoized ? { firstPaint: true } : {}) });
        await v.settle();
        const main = v.root.querySelector('main')!;
        const out: string[] = [seen(v, storage)];
        // the truth, whatever both pages share: every scope marked whole changes nothing on the page
        // (what the page shows: marking the persisted scope saves it, which is no binding)
        const blank = memoryStorage();
        const fresh = async () => {
          const was = seen(v, blank);
          for (const el of [main, main.querySelector('section')!]) v.state(el).update(() => {});
          await v.settle();
          const now = seen(v, blank);
          if (now !== was) stale.push(`${memoized ? 'memoized' : 'plain'} page, after step ${out.length - 1}: a binding missed a change\n    shown ${was}\n    fresh ${now}`);
        };
        for (const s of steps) {
          if (s.msg === 4) { stream.drop(); await v.settle(); }
          else if (s.msg >= 0 && stream.connected) s.msg === 3 ? stream.emit('re', null) : stream.emit('upd', { id: 1 + s.msg, n: 10 * (s.msg + 1) });
          if (s.b === 7) main.querySelectorAll<HTMLElement>('.yb')[s.row]?.click();
          else main.querySelector<HTMLElement>(['#h0', '#h1', '#h2', '.opt', '#ok', '#bad', '#pp', '', '#h3', '#h3'][s.b]!)?.click();
          if (s.flush) { await v.settle(); out.push(seen(v, storage)); await fresh(); }
        }
        await v.settle();
        out.push(seen(v, storage));
        await fresh();
        return { out, handlers: page(rng(seed)).handlers };
      };
      try {
        const got = await run(true), want = await run(false);
        const at = got.out.findIndex((x, i) => x !== want.out[i]);
        if (at >= 0) failures.push(`seed ${seed} depth ${DEPTH}${early ? ' (early takeover)' : ''}: step ${at} of ${JSON.stringify(steps)}\n  handlers ${JSON.stringify(got.handlers)}\n  memoized ${got.out[at]}\n  plain    ${want.out[at]}`);
        if (stale.length) failures.push(`seed ${seed} depth ${DEPTH}${early ? ' (early takeover)' : ''} of ${JSON.stringify(steps)}\n  handlers ${JSON.stringify(got.handlers)}\n  ${stale[0]}`);
      } catch (e) {
        failures.push(`seed ${seed}: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`);
      }
    }
  } finally { configure({ locale: null }); loc = 'en'; }
  if (process.env.SN_FUZZ_OUT) (await import('node:fs')).writeFileSync(process.env.SN_FUZZ_OUT, failures.join('\n\n'));
  expect(failures).toEqual([]);
}, Math.max(600_000, SEEDS * DEPTH * 600));

// @vitest-environment jsdom
// Cached lets against main's semantics (CONTRIBUTING.md, Fuzz tests). A let over a helper is computed once
// and kept until what it reads changes (lets.ts); a let without one is its expression, inlined at every read.
// Each case is one page twice: with lets over helpers (cached), and with each helper call written out as the
// expression it computes (inlined, the oracle). Random handlers mix writes in place and reassigned, store
// functions, refresh(), emit() with listeners that write and that read, a synchronous click on another
// element, an island whose prop setter fires an event in the middle of a flush, `<sn-sync>` messages and an
// optimistic action, with reads of lets stored into state between all of them; the buttons are clicked in a
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
];
const READS = ['T', 'P.v', 'N', 'TT', 'TS', 'T + N', 'P.v + TT'];
const OPS = [
  'a = a + 1', 'a = 7', 'xs.push(3)', 'xs = [...xs, 4]', 'xs.length && (xs[0] = xs[0] + 2)', 'xs.length > 1 && xs.pop()',
  'o.items.push(1)', 'o = { items: [...o.items, 2] }',
  'todos.length && patch(todos[0], { n: todos[0].n + 3 })', 'todos.length > 1 && remove(todos[todos.length - 1])', "upsert('todos', { id: 9, n: 90 })",
  "refresh('todos')", "emit('bump')", "emit('peek')", "$el.parentElement.querySelector('#x').click()", 'go = go + 1',
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
  const state = `{ a: 1, xs: [1, 2], o: { items: [1] }, go: 0, pk: null, ${Array.from({ length: reads }, (_, i) => `r${i}: null`).join(', ')} }`;
  const html = `<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>
<sn-sync src="/s"><sn-event name="upd" resource="todos" op="upsert"></sn-event></sn-sync>
<main data-sn-state="${state}" data-sn-let="{ ${lets} }" data-sn-on-bump="a = a + 10" data-sn-on-peek="pk = T + P.v" data-sn-on-ping="xs.length && (xs[0] = xs[0] + 5)">
  <${ISLAND} data-sn-prop="{ n: go }"></${ISLAND}>
  <p class="v" data-sn-text="[T, P.v, N, TT, TS].join(' ')"></p>
  <ul><template data-sn-for="x in xs"><li data-sn-let="{ R: ${call('inc(x)', 'x + 1')} }" data-sn-text="R + T"></li></template></ul>
  <c-v data-sn-prop="{ v: ${call('sum(xs)', 'xs.reduce((p, q) => p + q, 0)')} }"></c-v>
  <button id="x" data-sn-on-click="a = a + 100"></button>
  <template data-sn-for="t in todos" data-sn-key="t.id"><button class="opt" data-sn-patch="/api/t" data-sn-body="{ id: t.id }" data-sn-optimistic="patch(t, { n: 50 })"></button></template>
  ${handlers.map((h, i) => `<button id="h${i}" data-sn-on-click="${h}"></button>`).join('\n  ')}
</main>`;
  return { html, handlers };
}
const COMPONENTS = { 'c-v': '<template data-sn-component="{ v: number }"><b class="cv" data-sn-text="v"></b></template>' };
const requests = () => mockRequests({ 'GET /api/todos': [{ id: 1, n: 1 }, { id: 2, n: 2 }], 'PATCH /api/t': null });

/** what the user sees, and the state the handlers stored */
function seen(root: Element, state: unknown) {
  const main = root.querySelector('main')!;
  return `${main.querySelector('p.v')!.textContent} | ${[...main.querySelectorAll('li')].map((x) => x.textContent).join(',')} | ${main.querySelector('b.cv')?.textContent} | ${JSON.stringify(state)}`;
}

const SEEDS = Number(process.env.SN_FUZZ_SEEDS ?? 150);

test('random handlers over cached lets: every read and the page agree with the lets written out (main\'s semantics)', async () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    // one script of steps for both pages: which button, whether to flush, whether a server message arrives
    const sr = rng(seed * 7919);
    const steps = Array.from({ length: 3 + Math.floor(sr() * (3 * DEPTH + 1)) }, () => ({ b: Math.floor(sr() * 4), flush: sr() < 0.6, msg: sr() < 0.25 ? Math.floor(sr() * 3) : -1 }));
    const early = seed % 3 === 0;
    const run = async (oracle: boolean) => {
      const { html } = page(rng(seed), oracle);
      const stream = mockStream();
      const v = await render(html, { helpers: HELPERS, components: COMPONENTS, requests: requests(), streams: { '/s': stream }, strict: false, ...(early && !oracle ? { firstPaint: true } : {}) });
      await v.settle();
      const main = v.root.querySelector('main')!;
      const out: string[] = [seen(v.root, v.state(main).get())];
      for (const s of steps) {
        if (s.msg >= 0) stream.emit('upd', { id: 1 + s.msg, n: 10 * (s.msg + 1) });
        main.querySelector<HTMLElement>(s.b === 3 ? '.opt' : `#h${s.b}`)?.click();
        if (s.flush) { await v.settle(); out.push(seen(v.root, v.state(main).get())); }
      }
      await v.settle();
      out.push(seen(v.root, v.state(main).get()));
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

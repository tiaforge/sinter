// @vitest-environment jsdom
// Soundness of helpers' summaries (src/helper-flows.ts), under generated bodies: each seed writes a helper that wraps one
// of its argument's objects in containers and iteration (object and array literals, spreads, a Set and a Map built in it,
// `for…of`, `Array.from`, `entries()`, `keys()`, `values()`, destructuring, a callback reading an enclosing local, writes
// into locals: `push`, a member assignment, `map.get(k).push`, a call of another function of the module), and a page that
// keeps the result and writes through it to the object. The oracle is the dev module's write check (warning 36): the
// write must mark the object's path in the list it came from. A summary that is too narrow shows here (a test below
// gives every helper the empty summary and expects the check to fire).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { helperFlows, render, type Flow } from '../../src/testing/index.js';

const SEEDS = Number(process.env.SN_FUZZ_SEEDS ?? 150);
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/** a wrapper: what it makes of an expression `e` that holds the object at `path` (from the value), with statements before */
type Step = (e: string, path: string, local: string) => { pre?: string; e: string; path: string };
const STEPS: Step[] = [
  (e, p) => ({ e: `{ v: ${e} }`, path: `.v${p}` }),
  (e, p) => ({ e: `[${e}]`, path: `[0]${p}` }),
  (e, p) => ({ e: `[...[${e}]]`, path: `[0]${p}` }),
  (e, p) => ({ e: `({ ...{ v: ${e} } })`, path: `.v${p}` }),
  (e, p) => ({ e: `[...new Set([${e}])]`, path: `[0]${p}` }),
  (e, p) => ({ e: `[...new Map([['k', ${e}]]).values()]`, path: `[0]${p}` }),
  (e, p) => ({ e: `Array.from(new Map([['k', ${e}]]))`, path: `[0][1]${p}` }),
  (e, p) => ({ e: `[...new Map([['k', ${e}]])]`, path: `[0][1]${p}` }),
  (e, p) => ({ e: `[...new Map([[${e}, 1]]).keys()]`, path: `[0]${p}` }),
  (e, p) => ({ e: `Object.entries({ k: ${e} })`, path: `[0][1]${p}` }),
  (e, p) => ({ e: `[...[${e}].entries()]`, path: `[0][1]${p}` }),
  (e, p, l) => ({ pre: `const ${l} = []; for (const x of [${e}]) ${l}.push(x);`, e: l, path: `[0]${p}` }),
  (e, p, l) => ({ pre: `const ${l} = new Map([['k', ${e}]]); let ${l}v = null; for (const [, x] of ${l}) ${l}v = x;`, e: `${l}v`, path: p }),
  (e, p, l) => ({ pre: `const ${l} = {}; ${l}.v = ${e};`, e: l, path: `.v${p}` }),
  (e, p, l) => ({ pre: `const ${l} = new Map(); ${l}.set('k', []); ${l}.get('k').push(${e});`, e: `${l}.get('k')`, path: `[0]${p}` }),
  (e, p, l) => ({ pre: `const [${l}] = [${e}];`, e: l, path: p }),
  (e, p, l) => ({ pre: `const { v: ${l} } = { v: ${e} };`, e: l, path: p }),
  (e, p, l) => ({ pre: `const ${l} = ${e};`, e: `[1].map(() => ${l})`, path: `[0]${p}` }),
  (e, p) => ({ e: `[${e}].find(() => true)`, path: p }),
  (e, p) => ({ e: `[${e}].filter(() => true).slice(0)`, path: `[0]${p}` }),
  (e, p) => ({ e: `Array.from([${e}], (x) => ({ w: x }))`, path: `[0].w${p}` }),
  (e, p) => ({ e: `wrap(${e})`, path: `.i${p}` }),
  (e, p) => ({ e: `(Math.random() < 2 ? ${e} : null)`, path: p }),
];

/** one seed: the helper's module text and the path, from its result, to the object it was given */
function generate(seed: number) {
  const r = rng(seed * 7919 + 1);
  const i = Math.floor(r() * 2);
  let e = `ys[${i}]`, path = '';
  const pre: string[] = [];
  for (let k = 0, n = 1 + Math.floor(r() * 4); k < n; k++) {
    const s = STEPS[Math.floor(r() * STEPS.length)]!(e, path, `l${k}`);
    if (s.pre) pre.push(s.pre);
    e = s.e;
    path = s.path;
  }
  const code = `function wrap(x) { return { i: x }; }\nexport function h(ys) {\n  ${pre.join('\n  ')}\n  return ${e};\n}\n`;
  return { code, path, i };
}

async function run(seed: number, flowsFor?: (real: (name: string) => Flow) => (name: string) => Flow) {
  const { code, path, i } = generate(seed);
  const dir = mkdtempSync(join(tmpdir(), 'sn-hff-'));
  writeFileSync(join(dir, 'helpers.mjs'), code);
  const real = helperFlows(join(dir, 'helpers.mjs'), dir);
  const h = new Function(`${code.replace('export function', 'function')}\nreturn h;`)();
  const page = `<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }], sel: null }"><p data-sn-text="ys.map((y) => y.n).join(',')"></p>
    <button id="a" data-sn-on-click="sel = h(ys)"></button><button id="b" data-sn-on-click="sel${path}.n = sel${path}.n + 10"></button></main>`;
  const r = await render(page, { helpers: { h }, helperFlows: flowsFor ? flowsFor(real) : real, strict: false });
  r.root.querySelector<HTMLElement>('#a')!.click(); await r.settle();
  r.root.querySelector<HTMLElement>('#b')!.click(); await r.settle();
  const want = i ? '1,12' : '11,2';
  return { code, summary: real('h'), shown: r.root.querySelector('p')!.textContent, want, missed: r.warnings().filter((w) => w.code == 36).map((w) => w.message) };
}

test('generated helpers: a write through the result marks the object it came from (warning 36 stays silent, the page shows it)', async () => {
  const failures: string[] = [];
  let summarized = 0;
  const unread: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const x = await run(seed);
    if ('flows' in x.summary) summarized++; else unread.push(`seed ${seed}: ${x.summary.why}\n${x.code}`);
    if (x.missed.length || x.shown !== x.want) failures.push(`seed ${seed}: shown ${x.shown}, want ${x.want}; ${x.missed[0] ?? ''}\n${x.code}summary ${JSON.stringify(x.summary)}`);
  }
  expect(failures).toEqual([]);
  // (the analysis reads these bodies: a seed whose helper it cannot read checks nothing of it)
  expect(unread).toEqual([]);
  expect(summarized).toBe(SEEDS);
}, 120_000);

test('the oracle can fail: with every helper given the empty summary, the check fires', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const x = await run(seed, () => () => ({ flows: [] }));
    expect(x.missed.length, `seed ${seed}\n${x.code}`).toBeGreaterThan(0);
  }
}, 60_000);

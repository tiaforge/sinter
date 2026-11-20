// A URL template compiled to code (`urlCode`, compiler/compile.ts) makes the same string as `expand` fills it with
// (runtime/url.ts), or throws where `expand` throws: the early file's requests are built by the one and the page
// module's by the other, and the early file's response is handed over by URL. Random templates (literals with `?`,
// `&`, `=`, `/`, values side by side, whole query values) over random values (null, undefined, empty, lists with
// nulls, dot segments, unicode, `&`, `#`, `?`, `=`, spaces, numbers, booleans).
import { expect, test } from 'vitest';
import { urlCode } from '../src/compiler/compile.js';
import { $hq, $hv, expand } from '../src/runtime/url.js';
import type { UrlTemplate } from '../src/ir.js';

const SEEDS = Number(process.env.SN_FUZZ_SEEDS ?? 3000);
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const LITERALS = ['/api/', '/a', '/', 'x', '?', '?a=', '&b=', '&', '=', 'c', '?q=', '&limit=10', '-', '/comments', '?s=1', '&t=', 'é', '%20', '&&', '?&'];
const VALUES: unknown[] = [null, undefined, '', 'a', 'a b', 'é', '..', '.', '&', '#', '?', '=', '/', 0, 7, false, true, [], ['x', null, 'y'], [null], ['.', '&'], ['é'], '😀', 'a&b=c#d'];

/** what the compiled code makes, or the error it throws */
const run = (code: string, vals: unknown[]) => {
  try { return new Function('$hv', '$hq', 'v', `return ${code};`)($hv, $hq, vals); } catch (e) { return { throws: (e as Error).message }; }
};
const viaExpand = (tpl: UrlTemplate, vals: unknown[]) => {
  try { return expand(tpl, vals, vals.map((_, i) => (v: unknown[]) => v[i])); } catch (e) { return { throws: (e as Error).message }; }
};

test('the compiled URL of a template is the string expand makes of it, over random templates and values', () => {
  let compiled = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed), pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const tpl: UrlTemplate = [pick(['/api/', '/', '/a?x=', '/a?'])];
    let n = 0;
    for (let k = 1 + Math.floor(r() * 6); k--;) tpl.push(r() < 0.5 ? n++ : pick(LITERALS));
    const code = urlCode(tpl, Array.from({ length: n }, (_, i) => `v[${i}]`));
    if (code == null) continue;
    compiled++;
    for (let t = 0; t < 8; t++) {
      const vals = Array.from({ length: n }, () => pick(VALUES));
      expect(run(code, vals), `seed ${seed}: ${JSON.stringify(tpl)} over ${JSON.stringify(vals)} (${code})`).toEqual(viaExpand(tpl, vals));
    }
  }
  // most templates compile
  expect(compiled).toBeGreaterThan(SEEDS / 3);
});

test('the shapes pages write compile, with no helper where nothing can be left out', () => {
  expect(urlCode(['/articles/', 0, '/comments'], ['a'])).toBe('"/articles/" + $hv(a) + "/comments"');
  expect(urlCode(['/articles?tag=', 0], ['t'])).toBe('"/articles" + $hq([["tag", t]])');
  expect(urlCode(['/a?q=x', 0, '&n=1'], ['v'])).toBe('"/a?q=x" + $hv(v, 1) + "&n=1"');
  expect(urlCode(['/user'], [])).toBe('"/user"');
  expect(urlCode(['/a?x=', 0, '#h'], ['v'])).toBeNull();
});

test('an early request of a numbered list: the URL the early file makes is the one the pager asks for (withParams over expand), at the page the URL names', async () => {
  const { earlyRequests } = await import('../src/compiler/index.js');
  const { toPage, withParams: wp } = await import('../src/early.js');
  const PAGES: unknown[] = [undefined, null, '', '1', '2', '7', 3, 2.5, '0', '-1', 'x', '10abc'];
  for (const src of [['/api/feed'] as UrlTemplate, ['/api/u/', 1, '/a'] as UrlTemplate, ['/a?b=', 1] as UrlTemplate, ['/a?c=1'] as UrlTemplate]) {
    for (const o of [true, false]) for (const p of PAGES) {
      const k = o ? 'offset' : 'page', q = { [k]: o ? '0' : '1', limit: '10' };
      const r = earlyRequests([{ src, scope: -1, q, sp: { f: 0, k, s: 10, ...(o ? { o: 1 as const } : {}) } }], undefined);
      const got: string[] = [];
      const f = [() => p, () => 'v é'];
      new Function('f', ...r.uses, `return ${r.code};`)(f, ...r.uses.map((u) => ({ toPage, withParams: wp, $hv, $hq } as Record<string, unknown>)[u]))((u: () => string) => got.push(u()), [], {});
      const n = toPage(p);
      expect(got, `${JSON.stringify(src)} at ${String(p)}`).toEqual([wp(expand(src, {}, f), { ...q, [k]: String(o ? (n - 1) * 10 : n) })]);
    }
  }
});

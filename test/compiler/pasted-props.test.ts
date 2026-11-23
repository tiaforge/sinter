// A prop is a let: its code is put where the component's markup reads it (docs/proposals/redesign-notes/pipeline.md
// §4). A plain path or a literal goes in bare; where the text after the name would join it (`n.toFixed()` with
// `n: 1` read as `1.toFixed()`, which does not parse) it is in parentheses (redesign-notes/bugs.md, bug 2).
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

function run(body: string, files: Record<string, string>) {
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) all[`/p/src/components/${k}.html`] = v;
  return compile(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, componentNames: Object.keys(files),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in all) return all[p]!; throw new Error(`missing ${p}`); },
  });
}
const errors = (out: ReturnType<typeof run>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
/** the page module's functions, each of which must parse */
const fns = (out: ReturnType<typeof run>) => {
  const m = /const fns = \[\n([\s\S]*?)\n\];/.exec(out.module);
  expect(m).not.toBeNull();
  // eslint-disable-next-line no-new-func -- the test only parses the compiled functions
  expect(() => new Function(`return [${m![1]}]`)).not.toThrow();
  return m![1]!;
};
// (a written state keeps the bindings in the browser: their code is in the page module)
const LIVE = (inner: string) => `<div data-sn-state="{ s: 0 }">${inner}<button data-sn-on-click="s++" data-sn-text="s"></button></div>`;

describe('a number literal prop read with a member', () => {
  const N = '<template data-sn-props="{ n: number }"><span><b data-sn-text="n.toFixed(1)"></b><i data-sn-text="n + 1"></i><u data-sn-text="n .toFixed() + n?.toFixed() + n[\'toFixed\']() + `${n}`"></u></span></template>';

  test('`n.toFixed()` with `n: 1` is `(1).toFixed()`, and the other reads are as before', () => {
    const out = run(LIVE('<x-n data-sn-with="{ n: 1 }"></x-n>'), { 'x-n': N });
    expect(errors(out)).toEqual([]);
    const code = fns(out);
    expect(code).toContain('($) => ((1).toFixed(1))');
    // where nothing joins the number, it goes in bare (as before)
    expect(code).toContain('($) => (1 + 1)');
    expect(code).toContain('($) => (1 .toFixed() + 1?.toFixed() + 1[\'toFixed\']() + `${1}`)');
  });

  test('a decimal, a path and a string are as before', () => {
    const out = run(LIVE('<x-n data-sn-with="{ n: 1.5 }"></x-n><x-n data-sn-with="{ n: s }"></x-n>'), { 'x-n': N });
    expect(errors(out)).toEqual([]);
    const code = fns(out);
    expect(code).toContain('($) => (1.5.toFixed(1))');
    expect(code).toContain('($) => ($.$s0.s.toFixed(1))');
  });

  test('passed on to another component, and as a slot\'s data (`$slot.n.toFixed()`)', () => {
    const outer = '<template data-sn-props="{ m: number }"><x-n data-sn-with="{ n: m }"></x-n></template>';
    const slotted = '<template data-sn-props="{ cell: Slot<{ n: number }> }"><div><slot name="cell" data-sn-with="{ n: 2 }"><b></b></slot></div></template>';
    const out = run(LIVE('<x-outer data-sn-with="{ m: 3 }"></x-outer><x-s><i slot="cell" data-sn-text="$slot.n.toFixed(3) + s"></i></x-s><x-s><i slot="cell" data-sn-text="$slot.n.toFixed(2) + s"></i></x-s>'), { 'x-n': N, 'x-outer': outer, 'x-s': slotted });
    expect(errors(out)).toEqual([]);
    const code = fns(out);
    expect(code).toContain('(3).toFixed(1)');
    expect(code).toContain('(2).toFixed(3)');
  });
});

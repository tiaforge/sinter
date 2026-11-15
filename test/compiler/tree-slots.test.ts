// Tree slots (docs/proposals/component-libraries.md, section 4): the rules, at build time.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

function run(page: string, files: Record<string, string>) {
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) all[`/p/src/components/${k}.html`] = v;
  return compile(page, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in all) return all[p]!; throw new Error('missing'); } });
}
const errors = (o: ReturnType<typeof run>) => o.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
const body = (o: ReturnType<typeof run>) => /<body>([\s\S]*)<\/body>/.exec(o.html)![1]!.replace(/\s+/g, ' ').trim();

// inline (no shared definition): the root's markup expands its inner components, which place `cell`
const C = {
  'x-grid': '<template data-sn-component="{ rows: string[]; cell: Slot<{ v: string }> }"><table><tbody><template data-sn-for="r in rows"><tr><x-cell data-sn-prop="{ v: r }"></x-cell></tr></template></tbody></table></template>',
  'x-cell': '<template data-sn-component="{ v: string }"><td><slot name="cell" data-sn-prop="{ v }"><span data-sn-text="v"></span></slot></td></template>',
};

describe('the rules', () => {
  test('rule 2: the nearest enclosing root that declares the name fills it, in the caller\'s scope with `$slot`', () => {
    const o = run('<div data-sn-state="{ k: \'!\' }"><x-grid data-sn-prop="{ rows: [\'a\'] }"><b slot="cell" data-sn-text="$slot.v + k"></b></x-grid></div>', C);
    expect(errors(o)).toEqual([]);
    expect(o.html).toMatch(/<td><b><\/b><\/td>/);
    expect(o.module).toContain('($) => ($.r + $.$s0.k)');
    // unfilled: the default
    expect(run('<x-grid data-sn-prop="{ rows: [\'a\'] }"></x-grid>', C).html).toMatch(/<td><span><\/span><\/td>/);
  });

  test('rule 2: no enclosing root that declares it is an error at the use that leaves it without one', () => {
    expect(errors(run('<table><tbody><template data-sn-for="r in [1]" data-sn-key="r"><tr><x-cell data-sn-prop="{ v: \'a\' }"></x-cell></tr></template></tbody></table>', C)))
      .toEqual([expect.stringMatching(/^SN331 `<x-cell>` places the slot `cell` \(`<slot name="cell" data-sn-prop>`\), and no component around it declares `cell`/)]);
  });

  test('rule 3: a root in caller markup starts a new contract; rule 6: fills do not reach into slot content', () => {
    const BOX = '<template data-sn-component="{ cell: Slot<{ v: string }> }"><section><slot></slot><x-cell data-sn-prop="{ v: \'own\' }"></x-cell></section></template>';
    // the page's content passed to x-box holds an x-cell: x-box's fill does not reach it
    const o = run('<x-box><i slot="cell"></i><table><tbody><template data-sn-for="r in [1]" data-sn-key="r"><tr><x-cell data-sn-prop="{ v: \'s\' }"></x-cell></tr></template></tbody></table></x-box>', { ...C, 'x-box': BOX });
    expect(errors(o)).toEqual([expect.stringMatching(/^SN331 `<x-cell>` places the slot `cell`/)]);
    expect(body(o)).toContain('<td><i></i></td>');
  });

  test('rule 4: a root in its package\'s markup passes outer fills through; its own fill wins', () => {
    const OUTER = '<template data-sn-component="{ cell: Slot<{ v: string }> }"><div><x-grid data-sn-prop="{ rows: [\'a\'] }"></x-grid><x-grid data-sn-prop="{ rows: [\'b\'] }"><u slot="cell"></u></x-grid></div></template>';
    const o = run('<x-outer><em slot="cell"></em></x-outer>', { ...C, 'x-outer': OUTER });
    expect(errors(o)).toEqual([]);
    expect(o.html).toMatch(/<td><em><\/em><\/td>[\s\S]*<td><u><\/u><\/td>/);
  });

  test('rule 5: a declared slot placed nowhere inside the root', () => {
    expect(errors(run('<x-none></x-none>', { 'x-none': '<template data-sn-component="{ cell: Slot<{ v: string }> }"><div></div></template>' })))
      .toEqual([expect.stringMatching(/^SN331 `<x-none>` declares the slot `cell`, and nothing inside it places `cell`/)]);
  });

  test('rule 7: the helper form of <sn-component use> in a component with slots', () => {
    const H = '<template data-sn-component="{ b: any; cell: Slot<{ v: string }> }"><div><slot name="cell" data-sn-prop="{ v: 1 }"></slot><sn-component use="pick(b)" data-sn-prop="{ b }"></sn-component></div></template>';
    const o = compile('<x-h data-sn-prop="{ b: 1 }"></x-h>', { file: '/p/index.html', root: '/p', dev: false, helpers: { module: '/h.js', names: ['pick'], namespaces: {} }, readFile: (p) => { if (p.endsWith('components/x-h.html')) return H; throw new Error('missing'); } });
    expect(errors(o)).toContainEqual(expect.stringMatching(/^SN312 `<x-h>` declares slots, so `<sn-component use>` in it names its candidates/));
  });

  test('rule 1: a tree placement whose name is close to a declared one is a warning with a suggestion', () => {
    const X = '<template data-sn-component="{ cell: Slot<{ n: number }> }"><div><slot name="cell" data-sn-prop="{ n: 1 }"></slot><slot name="cel" data-sn-prop="{ n: 2 }"></slot></div></template>';
    expect(run('<x-close></x-close>', { 'x-close': X }).diagnostics.map((d) => `${d.code} ${d.message}`)).toContainEqual(expect.stringMatching(/^SN535 .*Did you mean `cell`\?/));
  });
});

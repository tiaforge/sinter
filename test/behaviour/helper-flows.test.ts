// @vitest-environment jsdom
// A helper's summary in a page (docs/spec.md, Aliases): what holds its result aliases only what the summary says of its
// arguments, and a write through it still reaches every binding that reads what changed. A helper without one: anything
// below every argument, as before.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { helperFlows, render } from '../../src/testing/index.js';

const text = (r: Awaited<ReturnType<typeof render>>, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };

/** a helpers module written to disk: its functions (to run) and its summaries (read from its text) */
async function helpersModule(code: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sn-hfb-'));
  const file = join(dir, 'helpers.mjs');
  writeFileSync(file, code);
  // (the same text, run: its exports as one object)
  const names = [...code.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]!);
  const fns = new Function(`${code.replace(/export (const|function) /g, '$1 ')}\nreturn { ${names.join(', ')} };`)() as Record<string, (...a: never[]) => unknown>;
  return { fns, flows: helperFlows(file, dir), names };
}
const writes = (html: string, names: string[], flows?: ReturnType<typeof helperFlows>) => {
  const out = compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: '/src/sinter.helpers.ts', names, namespaces: {} }, readFile: () => { throw new Error('none'); }, ...(flows ? { helperFlows: flows } : {}) });
  return [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'on' && b.w).map((b) => (b.w as string[]).slice().sort()));
};

const CODE = `
export const kept = (p) => { const out = []; out.push(p); return out; };
export const held = (p) => { const o = {}; o.v = p; return o; };
export const takenBack = (p) => { const m = new Map(); m.set('k', []); m.get('k').push(p); return [...m.values()][0][0]; };
export const opened = (sel, key) => ({ ...sel, cursor: key });
export const keyOf = (y) => 'k' + y.n;
export const bumps = (p) => { p.n = p.n + 1; return p; };
`;
const PAGE = (make: string, write: string) => `<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }], other: { n: 7 }, box: null }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul><b data-sn-text="other.n"></b>
  <button id="a" data-sn-on-click="${make}"></button><button id="b" data-sn-on-click="${write}"></button></main>`;

describe('writes into locals keep what was stored', () => {
  test.each([
    ['the local itself (`out.push(p); return out`)', 'box = kept(ys[1])', 'box[0].n = 20'],
    ['a member of the local (`o.v = p; return o`)', 'box = held(ys[1])', 'box.v.n = 20'],
    ['an element taken back out of a Map\'s list', 'box = takenBack(ys[1])', 'box.n = 20'],
  ])('%s: the write through the result reaches the list, and marks no more than the argument', async (_, make, write) => {
    const { fns, flows, names } = await helpersModule(CODE);
    const w = writes(PAGE(make, write), names, flows).find((x) => x.some((p) => p.endsWith('.n') && p.startsWith('$s0.box')))!;
    expect(w).toContain('$s0.ys.1.n');
    expect(w.filter((p) => p.startsWith('$s0.other') || p === '$s0.**')).toEqual([]);
    const r = await render(PAGE(make, write), { helpers: fns, helperFlows: flows, strict: false });
    await click(r, '#a');
    await click(r, '#b');
    expect(text(r, 'li')).toBe('1,20');
    expect(r.warnings().filter((x) => x.code == 36)).toEqual([]);
  });
});

describe('summary shapes in a page', () => {
  test('a spread of the argument and a primitive result: what the result holds is the argument\'s, or nothing', async () => {
    const { flows, names } = await helpersModule(CODE);
    const ws = writes(`<main data-sn-state="{ sel: { cursor: '', keys: [] }, ys: [{ n: 1 }], k: '' }"><b data-sn-text="sel.cursor + sel.keys.length + k + ys[0].n"></b>
      <button data-sn-on-click="sel = opened(sel, k)"></button><button data-sn-on-click="sel.keys.push(1)"></button><button data-sn-on-click="k = keyOf(ys[0])"></button></main>`, names, flows);
    // the push into the spread copy's list reaches the original's (the copy shares it), not `ys`
    expect(ws[1]).toEqual(['$s0.sel.keys.#']);
    expect(ws[2]).toEqual(['$s0.k']);
  });
  test('a helper that writes into its argument has no summary: as before, anything below every argument, and a call of it marks the argument changed', async () => {
    const { fns, flows, names } = await helpersModule(CODE);
    const html = PAGE('box = bumps(ys[0])', 'box.n = 30');
    const ws = writes(html, names, flows);
    expect(ws[0]).toContain('$s0.ys');
    expect(ws[1]).toContain('$s0.ys.0.**');
    const r = await render(html, { helpers: fns, helperFlows: flows, strict: false });
    await click(r, '#a');
    expect(text(r, 'li')).toBe('2,2');
    await click(r, '#b');
    expect(text(r, 'li')).toBe('30,2');
    expect(r.warnings().filter((x) => x.code == 36)).toEqual([]);
  });
  test('without summaries (`compile()`), anything below every argument', async () => {
    const { names } = await helpersModule(CODE);
    expect(writes(PAGE('box = held(ys[1])', 'box.v.n = 20'), names).find((x) => x.includes('$s0.box.v.n'))).toContain('$s0.ys.1.**');
  });
});

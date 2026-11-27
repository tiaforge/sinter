// SN548 (`sinter({ explainWrites: true })`): each alias whose value the compiler cannot follow, where it was made, what
// it holds and the handlers whose writes it makes everything. It reports; it changes nothing that is marked.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { strictPromotes } from '../../src/compiler/diagnostics.js';

const helpers = { module: '/src/sinter.helpers.ts', names: ['pick'], namespaces: {} };
const compile = (html: string, explainWrites?: boolean) => compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: () => { throw new Error('none'); }, ...(explainWrites ? { explainWrites } : {}) });
const sn548 = (html: string) => compile(html, true).diagnostics.filter((d) => d.code === 'SN548');
const writes = (out: ReturnType<typeof compile>) => [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.w).map((b) => b.w));

const UNTRACEABLE = `<main data-sn-state="{ ys: [{ n: 1 }], sel: null, k: 0 }"><b data-sn-text="ys[0].n + (sel ? sel.n : 0) + k"></b>
  <button data-sn-on-click="sel = ys.reduce((a, y) => y, null)"></button>
  <button data-sn-on-click="sel.n = 5"></button>
  <button data-sn-on-click="ys[0].n = 6"></button>
  <button data-sn-on-click="k = k + 1"></button></main>`;

describe('SN548', () => {
  test('names the alias once, where it was made, with what it holds and the handlers it makes everything', () => {
    const ds = sn548(UNTRACEABLE);
    expect(ds).toHaveLength(1);
    const d = ds[0]!;
    expect(d).toMatchObject({ severity: 'warning', file: '/p/index.html', line: 2 });
    expect(d.message).toContain('`sel` may hold any of the page\'s objects (`ys.reduce((a, y) => y, null)` is the result of `reduce()`)');
    // the write inside the alias (the one inside the list reaches what reads the alias, not everything)
    expect(d.message).toContain('so the writes of a handler cannot be followed and re-render everything that reads state: `data-sn-on-click` (index.html:3).');
    expect(d.message).toContain('It was made by `sel = ys.reduce((a, y) => y, null)`');
    expect(d.hint).toContain('structuredClone');
  });

  test('changes no write list, and is off by default', () => {
    expect(writes(compile(UNTRACEABLE, true))).toEqual(writes(compile(UNTRACEABLE)));
    expect(compile(UNTRACEABLE).diagnostics.filter((d) => d.code === 'SN548')).toEqual([]);
  });

  test('a page whose aliases the compiler follows has none', () => {
    expect(sn548(`<main data-sn-state="{ ys: [{ n: 1 }], sel: null }"><b data-sn-text="ys[0].n + (sel ? sel.n : 0)"></b>
      <button data-sn-on-click="sel = ys[0]"></button><button data-sn-on-click="sel.n = 5"></button><button data-sn-on-click="sel = pick(ys)"></button></main>`)).toEqual([]);
  });

  test('through a `data-sn-let`, what the let\'s value is; an event\'s detail, why it is not followed', () => {
    const ds = sn548(`<main data-sn-state="{ ys: [{ n: 1 }], sel: null, box: null }" data-sn-let="{ last: ys.reduce((a, y) => y, null) }" data-sn-on-pick="box = $event.detail"><b data-sn-text="ys[0].n + (sel ? sel.n : 0)"></b>
      <button data-sn-on-click="sel = last"></button><button data-sn-on-click="sel.n = 6"></button><button data-sn-on-click="box.n = 7"></button></main>`);
    expect(ds.map((d) => d.message.split(' (')[0])).toEqual(expect.arrayContaining(['`sel` may hold any of the page\'s objects', '`box` may hold any of the page\'s objects']));
    expect(ds.find((d) => d.message.startsWith('`sel`'))!.message).toContain('`ys.reduce((a, y) => y, null)` is the result of `reduce()`');
    expect(ds.find((d) => d.message.startsWith('`box`'))!.message).toContain('`$event` of `pick` may be any object: the build did not read the page\'s modules');
  });

  test('a state field\'s initial value: at its `data-sn-state`', () => {
    const [d, ...more] = sn548(`<sn-resource name="rs" src="/r"></sn-resource><main data-sn-state="{ sel: rs.reduce((a, y) => y, null) }"><b data-sn-text="sel.n"></b>
      <button data-sn-on-click="sel.n = 5"></button></main>`);
    expect(more).toEqual([]);
    expect(d!.line).toBe(1);
    expect(d!.message).toContain('It was made by `{ sel: rs.reduce((a, y) => y, null) }`');
  });

  test('stays a warning in strict mode', () => {
    expect(strictPromotes('SN548')).toBe(false);
  });
});

describe('SN548 names what blocked the proof', () => {
  const HOLD = '<template data-sn-props="{ item: { n: number } }"><span data-sn-state="{ held: null }"><button data-sn-on-click="held && (held.n = 1)"></button></span></template>';
  const PICK = `<template data-sn-props="{ ys: Array<{ n: number }> }" data-sn-emits="{ pick: { n: number } }"><button data-sn-on-click="emit('pick', ys.reduce((a, y) => y, null))"></button></template>`;
  const run = (html: string, files: Record<string, string>, events = { unknown: null, risky: new Map<string, string>() }) => compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers, explainWrites: true, eventSenders: () => events,
    componentNames: Object.keys(files).filter((f) => f.endsWith('.html')).map((f) => f.replace(/^.*\/|\.html$/g, '')),
    readFile: (f: string) => { const k = f.replace(/^\/p\//, ''); if (k in files) return files[k]!; throw new Error('none'); } }).diagnostics.filter((d) => d.code === 'SN548').map((d) => d.message);
  const PAGE = `<main data-sn-state="{ ys: [{ n: 1 }], sel: null }"><b data-sn-text="ys[0].n"></b><div data-sn-on-pick="sel = $event.detail"><x-pick data-sn-with="{ ys }"></x-pick></div>
    <x-hold data-sn-with="{ item: ys[0] }"></x-hold><button data-sn-on-click="sel.n = 2"></button></main>`;
  test('a component script: the statement and its place', () => {
    const ms = run(PAGE, { 'src/components/x-hold.html': HOLD, 'src/components/x-hold.ts': 'export class XHold {\n  connected() { this.state.held = this.props.item; }\n}', 'src/components/x-pick.html': PICK });
    expect(ms.join('\n')).toMatch(/`<x-hold>`'s script may give its state's fields any object: `this\.state\.held` given a value the build cannot follow \(src\/components\/x-hold\.ts:2:17\)/);
  });
  test('an event\'s sender: the module and its place; a markup `emit()`: what it passes', () => {
    const files = { 'src/components/x-pick.html': PICK };
    expect(run(PAGE.replace(/<x-hold[^>]*><\/x-hold>/, ''), files, { unknown: null, risky: new Map([['pick', '`pick` is made with a detail the build cannot follow (src/lib/pick.ts:3:1)']]) }).join('\n'))
      .toContain('`$event` of `pick` may be any object: `pick` is made with a detail the build cannot follow (src/lib/pick.ts:3:1)');
    expect(run(PAGE.replace(/<x-hold[^>]*><\/x-hold>/, ''), files).join('\n')).toContain('`ys.reduce((a, y) => y, null)` is the result of `reduce()`');
  });
});

test('SN548 names a helper whose body gave no summary, and the construct that stopped it', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { helperFlows } = await import('../../src/helper-flows.js');
  const dir = mkdtempSync(join(tmpdir(), 'sn-548-'));
  writeFileSync(join(dir, 'helpers.mjs'), 'export function bumps(p) {\n  p.n = p.n + 1;\n  return p;\n}\n');
  const out = compileParts(`<main data-sn-state="{ ys: [{ n: 1 }], box: null }"><b data-sn-text="ys[0].n"></b><button data-sn-on-click="box = bumps(ys[0])"></button><button data-sn-on-click="box.n = 3"></button></main>`,
    { file: '/p/index.html', root: '/p', dev: false, helpers: { module: '/x', names: ['bumps'], namespaces: {} }, explainWrites: true, helperFlows: helperFlows(join(dir, 'helpers.mjs'), dir), readFile: () => { throw new Error('none'); } });
  const [m, ...more] = out.diagnostics.filter((d) => d.code === 'SN548').map((d) => d.message);
  expect(more).toEqual([]);
  expect(m).toMatch(/^`bumps\(\)`'s result is taken to hold anything below its arguments, so a write through what holds it marks all of that: its body has no summary, a write into an object of a parameter \(.*helpers\.mjs:2:3\)\. It is used in `box = bumps\(ys\[0\]\)`$/);
});

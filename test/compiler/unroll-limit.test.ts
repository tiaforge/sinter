// A constant list unrolls at build time as long as the page's budget holds (`expansionLimit`, every row and
// component instance counted): no list has a limit of its own. Past the budget the list renders in the browser,
// with SN536 at its loop. `sinter({ expansionLimit })` sets the budget for a site.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { expansionLimitOf } from '../../src/project.js';

const page = (n: number) => `<!doctype html><html><head></head><body><div data-sn-state="{ xs: Array.from({ length: ${n} }, (_, i) => i) }"><ul><template data-sn-for="x in xs"><li data-sn-text="x"></li></template></ul></div></body></html>`;
const build = (html: string, o: Record<string, unknown> = {}) => compile(html, {
  file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} },
  readFile: () => { throw new Error('no files'); }, ...o,
});
const rows = (html: string) => (html.match(/<li>/g) ?? []).length;

describe('unrolling a constant list', () => {
  test('5,000 rows: unrolled, far under the page\'s budget (there used to be a limit of 1,000 per list)', () => {
    const out = build(page(5000));
    expect(out.diagnostics).toEqual([]);
    expect(rows(out.html)).toBe(5000);
    expect(out.html).not.toContain('<template');
  });

  test('past the budget: rendered in the browser, with SN536 at the loop', () => {
    const out = build(page(12_000));
    expect(out.diagnostics.map((d) => [d.code, d.severity])).toEqual([['SN536', 'warning']]);
    expect(out.diagnostics[0]!.message).toMatch(/this list's rows would take the page past 10,000 rows and components expanded at build time/);
    expect(out.diagnostics[0]!.hint).toMatch(/sinter\(\{ expansionLimit \}\)/);
    expect(out.html).not.toContain('<li>0</li>');
    expect(out.html).toContain('<template');
  });

  test('a site\'s own budget', () => {
    expect(rows(build(page(12_000), { expansionLimit: 20_000 }).html)).toBe(12_000);
    expect(build(page(50), { expansionLimit: 20 }).diagnostics.map((d) => d.code)).toEqual(['SN536']);
  });

  test('sinter({ expansionLimit }) is a whole number of 1 or more', () => {
    expect(expansionLimitOf(undefined)).toBe(undefined);
    expect(expansionLimitOf(25_000)).toBe(25_000);
    for (const bad of [0, -1, 1.5, Number.NaN, '100' as unknown as number]) expect(() => expansionLimitOf(bad)).toThrow(/expansionLimit: .* is not a whole number of 1 or more/);
  });
});

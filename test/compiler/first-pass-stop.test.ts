// The first of two passes stops at its decisions (`compilePasses`, `quietFinish`; docs/proposals/redesign-notes/floor.md):
// when a second pass follows whatever the rest of the first reports, nothing of that rest is read. Where the rest can
// report an error (a signed-in guard, `$url` lists, a page per entry), it runs as before: the error keeps the second pass
// from unrolling.
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const options = (extra: Partial<CompileOptions> = {}): CompileOptions => ({
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: '/h.js', names: [], namespaces: {} },
  readFile: () => { throw new Error('missing'); },
  ...extra,
});
const page = (body: string, html = '') => `<!doctype html><html${html}><head></head><body>${body}</body></html>`;
const irOf = (module: string) => JSON.parse(/const ir = (\{.*\});/.exec(module)![1]!);
const BODY = '<div data-sn-state="{ open: true }"><template data-sn-if="open"><p>open</p></template><ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul></div>';

describe('the first pass stops at its decisions', () => {
  test('a page that decides and unrolls: the second pass gets both', () => {
    const out = compile(page(BODY), options());
    expect(out.diagnostics).toEqual([]);
    expect(out.html).toContain('<p>open</p>');
    expect(out.html).toContain('<li>1</li><li>2</li>');
  });

  test('an error the rest of the first pass reports (SN347) still keeps the loop from unrolling', () => {
    const out = compile(page(BODY, ' data-sn-signed-in'), options());
    expect(out.diagnostics.map((d) => d.code)).toContain('SN347');
    expect(out.html).toContain('<p>open</p>');
    expect(out.html).not.toContain('<li>1</li>');
    expect(irOf(out.module).templates.length).toBeGreaterThan(0);
  });
});

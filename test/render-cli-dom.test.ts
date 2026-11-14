// @vitest-environment node
// `sinter render` on jsdom: the stand-ins for what jsdom lacks record that they were used, so the
// report can say why a part that measures itself looks empty; the globals are put back afterwards.
import { expect, test } from 'vitest';
import { installDom, standIns } from '../src/render-cli.js';

test('stand-ins record their use, and the globals are restored', async () => {
  expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  const restore = await installDom('http://localhost/');
  try {
    expect(standIns.size).toBe(0);
    new ResizeObserver(() => {}).observe(document.body);
    expect(matchMedia('(prefers-color-scheme: dark)').matches).toBe(false);
    expect([...standIns]).toEqual(['ResizeObserver', 'matchMedia']);
  } finally { restore(); }
  expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  expect(typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver).toBe('undefined');
});

test('a component that constructs a ResizeObserver: the report names the stand-in, and the exit code stays 0', async () => {
  const { resolve } = await import('node:path');
  const { failed, formatReport, parseRenderArgs, renderPage } = await import('../src/render-cli.js');
  const a = parseRenderArgs(['measured.html'], resolve(__dirname, 'fixtures/render-app'));
  if (typeof a === 'string') throw new Error(a);
  const r = await renderPage(a);
  expect(r.rendered).toContain('<div class="box" data-sn-c="size-box">chart</div>');
  expect(r.standIns).toEqual(['ResizeObserver (nothing is measured)']);
  expect(formatReport(r)).toContain('jsdom stand-ins used: ResizeObserver (nothing is measured)');
  expect(failed(r)).toBe(false);
  expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
});

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

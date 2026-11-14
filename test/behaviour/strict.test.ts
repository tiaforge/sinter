// render() in strict mode: the page's warnings throw like errors, runtime warnings reject the call that ran them.
import { afterEach, expect, test, vi } from 'vitest';
import { render } from '../../src/testing/index.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const quiet = () => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); };

const dupes = '<ul data-sn-state="{ xs: [1, 2] }"><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template><button data-sn-on-click="xs = [3, 3]">dupe</button></ul>';

test('a page warning throws in strict mode, unless its code is allowed', async () => {
  const stale = '<p data-sn-text="Date.now()"></p>';
  await render(stale);
  await expect(render(stale, { strict: true })).rejects.toThrow(/error SN502 non-reactive-value/);
  await render(stale, { strict: { allow: { SN502: 'the test is about a stale clock' } } });
});

test('a runtime warning rejects the call that ran it; warnings() has it either way', async () => {
  quiet();
  const loose = await render(dupes);
  loose.root.querySelector('button')!.click();
  await loose.flush();
  expect(loose.warnings().map((w) => w.message)).toEqual(['sinter: duplicate key in `data-sn-for`: 3']);

  const strict = await render(dupes, { strict: true });
  strict.root.querySelector('button')!.click();
  await expect(strict.flush()).rejects.toThrow(/1 runtime warning\(s\) in strict mode[\s\S]*duplicate key in `data-sn-for`: 3/);
  // reported once: the next call passes
  await strict.flush();
});

test('SINTER_STRICT turns it on, and `strict: false` off again', async () => {
  quiet();
  vi.stubEnv('SINTER_STRICT', '1');
  await expect(render('<p data-sn-text="Date.now()"></p>')).rejects.toThrow(/SN502/);
  const r = await render(dupes, { strict: false });
  r.root.querySelector('button')!.click();
  await r.flush();
  expect(r.warnings()).toHaveLength(1);
});

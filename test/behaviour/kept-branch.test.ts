// A kept element's branches across swaps (docs/proposals/swap-navigation.md §3): the old page's code hands what it
// rendered in a kept element to the next page's (`handOver`), which adopts it when the same branch is to show.
// caley: a branch the page before showed as none, and the next page too, reloaded the page (`make` of branch 0).
import { $hq, $hv } from '../../src/runtime/url.js';
import { afterEach, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { compactIR } from '../../src/ir.js';
import { instance, mount } from '../../src/runtime/app.js';
import { defaultEnv } from '../../src/runtime/env.js';
import { handOver } from '../../src/swap-run.js';

afterEach(() => { try { instance(document).destroy(); } catch { /* none */ } });

const source = (flag: boolean) => `<html><head></head><body><nav data-sn-permanent="rail" data-sn-state="{ on: ${flag} }"><button data-sn-on-click="on = !on">t</button><template data-sn-if="on"><b>shown</b></template></nav></body></html>`;
const compiled = (flag: boolean) => compileParts(source(flag), { file: '/p/x.html', root: '/p', dev: false, swap: true, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } });
const page = (flag: boolean) => {
  const parts = compiled(flag);
  const fns = new Function('$k', '$hv', '$hq', `return [${parts.fns.join(',')}]`)((x: unknown) => x, $hv, $hq);
  return { ir: compactIR(parts.ir), fns };
};
const html = (flag: boolean) => /<body>([\s\S]*)<\/body>/i.exec(compiled(flag).html)![1]!;
const env = { ...defaultEnv, href: () => 'http://localhost/' };

/** what swap-run.ts does with a kept element: hand over, destroy, the next page's code mounts on the element as it is */
function swapTo(next: ReturnType<typeof page>) {
  const old = instance(document), kept = document.querySelector('nav')!;
  handOver(old.rbs, [kept]);
  old.destroy();
  return mount(document, { ...next, env });
}

test.each([[false, false], [false, true], [true, true], [true, false]])('the page before shows the branch: %s, the next page: %s', async (before, after) => {
  const first = page(before);
  document.body.innerHTML = html(before);
  mount(document, { ...first, env });
  await Promise.resolve();
  expect(!!document.querySelector('b')).toBe(before);
  const b = document.querySelector('b');
  swapTo(page(after));
  await Promise.resolve();
  expect(!!document.querySelector('b')).toBe(after);
  // a branch shown on both pages is adopted, not built again
  if (before && after) expect(document.querySelector('b')).toBe(b);
  // and it still toggles
  document.querySelector('button')!.click();
  await Promise.resolve();
  expect(!!document.querySelector('b')).toBe(!after);
});

test('shown, then a page that shows none, then a page that shows none either (caley: calendar → mail → settings)', async () => {
  document.body.innerHTML = html(true);
  mount(document, { ...page(true), env });
  await Promise.resolve();
  expect(!!document.querySelector('b')).toBe(true);
  swapTo(page(false));
  await Promise.resolve();
  expect(!!document.querySelector('b')).toBe(false);
  swapTo(page(false));
  await Promise.resolve();
  expect(!!document.querySelector('b')).toBe(false);
  document.querySelector('button')!.click();
  await Promise.resolve();
  expect(!!document.querySelector('b')).toBe(true);
});

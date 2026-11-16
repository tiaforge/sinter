// The page module with swaps on (docs/proposals/swap-navigation.md §6): it exports its mount (`boot`) and
// the names it keeps (`kept`) instead of only mounting itself, and mounts itself only on a load, so the
// swap can import it once and mount it at each visit: the same IR mounted again, on the next body.
import { expect, test } from 'vitest';
import * as sinter from '../../src/index.js';
import { compile } from '../../src/compiler/index.js';

const PAGE = '<!doctype html><html><head><title>x</title></head><body><aside data-sn-permanent="player"></aside><div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++"></button><b data-sn-text="n"></b></div></body></html>';
const build = (swap: boolean) => compile(PAGE, { file: '/p/a.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '', moduleSrc: '/m.js', ...(swap ? { swap: true } : {}) });

/** runs a page module (its imports from sinter given, its exports returned) */
async function run(module: string): Promise<{ boot?: () => sinter.App; kept?: string[] }> {
  const imports = /^import \{ ([^}]*) \} from '@tiaforge-ui\/sinter';$/m.exec(module)![1]!;
  const body = module.replace(/^import .*$/gm, '').replace(/^export const (\w+)/gm, (_, n: string) => `const ${n} = $exports.${n}`);
  const fn = new Function('$sinter', '$exports', `return (async () => { const { ${imports} } = $sinter; ${body} })();`);
  const exports = {};
  await fn(sinter, exports);
  return exports;
}
const SWAPPING = Symbol.for('sinter.swapping');
const body = () => /<body>([\s\S]*)<\/body>/.exec(build(true).html)![1]!;
const click = async () => { document.querySelector('button')!.click(); await new Promise((r) => setTimeout(r, 0)); };

test('without swaps: the module mounts itself and exports nothing (as before)', () => {
  const m = build(false).module;
  expect(m).not.toContain('export ');
  expect(m).toMatch(/^mount\(document, \{ ir, fns, features: \[\] \}\);$/m);
});

test('with swaps: imported by the swap, nothing mounts; each boot mounts the page on the body there', async () => {
  const m = build(true).module;
  expect(m).toContain('export const kept = ["player"];');
  (globalThis as Record<symbol, unknown>)[SWAPPING] = true;
  document.body.innerHTML = body();
  let page: Awaited<ReturnType<typeof run>>;
  try { page = await run(m); } finally { delete (globalThis as Record<symbol, unknown>)[SWAPPING]; }
  expect(page.kept).toEqual(['player']);
  // not mounted: nothing rendered, a click does nothing
  await click();
  expect(document.querySelector('b')!.textContent).toBe('');
  // a visit: mounted, then destroyed when the next one comes, and mounted again on a fresh body
  const first = page.boot!();
  await click();
  expect(document.querySelector('b')!.textContent).toBe('1');
  first.destroy();
  document.body.innerHTML = body();
  const second = page.boot!();
  await click();
  await click();
  expect(document.querySelector('b')!.textContent).toBe('2');
  second.destroy();
});

test('with swaps, on a load: the module mounts itself', async () => {
  document.body.innerHTML = body();
  await run(build(true).module);
  await click();
  expect(document.querySelector('b')!.textContent).toBe('1');
  sinter.instance(document).destroy();
});

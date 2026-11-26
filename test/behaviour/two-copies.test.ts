// Two copies of the runtime in one page (docs/libraries.md#using-one): a library linked with `file:` or `npm link`
// brought its own sinter, whose `instance()` knew none of the app's mounts. caley: a self-saving sortable found no
// app (it looks for its mount root through the ancestors, catching each throw) and saved nothing, silently.
import { $hq, $hv } from '../../src/runtime/url.js';
import { afterEach, expect, test, vi } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { compactIR } from '../../src/ir.js';
import { instance, mount } from '../../src/runtime/app.js';
import { defaultEnv } from '../../src/runtime/env.js';

afterEach(() => { try { instance(document).destroy(); } catch { /* none */ } vi.restoreAllMocks(); });

const page = () => {
  const parts = compileParts('<html><head></head><body><p data-sn-state="{ n: 1 }" data-sn-text="n"></p></body></html>', { file: '/p/x.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } });
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/i.exec(parts.html)![1]!;
  const fns = new Function('$k', '$hv', '$hq', `return [${parts.fns.join(',')}]`)((x: unknown) => x, $hv, $hq);
  return { ir: compactIR(parts.ir), fns };
};

test("a second copy's instance() names the cause, and the app's copy warns", async () => {
  const app = mount(document, { ...page(), env: { ...defaultEnv, href: () => 'http://localhost/' } });
  expect(instance(document)).toBe(app);
  // another copy of the module, as a library's own sinter is
  const other = (await import('../../src/runtime/app.js?copy' as string)) as typeof import('../../src/runtime/app.js');
  expect(other.instance).not.toBe(instance);
  // the app's copy says why, through its warnings (readable in dev)
  const warn = vi.spyOn(app, 'warn');
  expect(() => other.instance(document)).toThrow(/^sinter: mounted by another copy$/);
  expect(warn).toHaveBeenCalledWith(34);
  // a root no copy mounted is the plain error, and nothing is logged
  expect(() => other.instance(document.body)).toThrow(/^sinter: not mounted$/);
  expect(() => instance(document.body)).toThrow(/^sinter: not mounted$/);
  expect(warn).toHaveBeenCalledTimes(1);
});

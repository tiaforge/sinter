// A component's early renderer (docs/components.md#early-renderers): `<name>.early.ts` beside its script fills the root
// in the early script where the use's props are known early (embedded data here), and the instance that adopts the root
// sees `this.early` and keeps what is there. Where the early script cannot render it, the script renders at mount.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { earlyModule } from '../../src/compiler/index.js';
import { mockRequests, render } from '../../src/testing/index.js';

const VIEW = '<template data-sn-props="{ text?: string | null }"><div class="v"></div></template>';
const PAGE = (data: string | null, use = '<x-view data-sn-with="{ text: c?.t }"></x-view>') => `<!doctype html><html><head>${data === null ? '' : `<script type="application/json" data-sn-resource="c">${data}</script>`}</head><body>
  <sn-resource name="c" src="/api/c"></sn-resource>
  <main>${use}<p id="after">after</p></main>
</body></html>`;

/** what each instance's `connected()` saw, and the renderer's calls */
let seen: boolean[] = [], drawn: unknown[] = [];
const fill = (root: Element, props: { text?: string | null }) => { drawn.push(props); const b = document.createElement('b'); b.textContent = props.text ?? ''; root.replaceChildren(b); };
class XView {
  declare early: boolean; declare root: HTMLElement; declare props: { text?: string | null };
  connected() { seen.push(this.early); if (!this.early) fill(this.root, this.props); }
  propsChanged() { fill(this.root, this.props); }
}

beforeEach(() => { seen = []; drawn = []; vi.stubGlobal('fetch', () => new Promise(() => {})); });
afterEach(() => { vi.unstubAllGlobals(); });

async function run(html: string, renderer: unknown = fill) {
  let early = '', el: Element | null = null;
  const r = await render(html, {
    requests: mockRequests({ 'GET /api/c': { t: 'from the API' } }), components: { 'x-view': VIEW }, scripts: { 'x-view': XView },
    ...(renderer ? { earlyRenderers: { 'x-view': renderer } } : {}),
    firstPaint: { afterEarly: () => { const v = document.querySelector('.v')!; early = v.innerHTML; el = v.firstElementChild; } },
  });
  await r.settle();
  const v = r.root.querySelector('.v')!;
  return { early, after: v.innerHTML, kept: !!el && v.firstElementChild === el };
}

test('an embedded use renders in the first paint through the early renderer, and the instance keeps it', async () => {
  const r = await run(PAGE('{"t":"hello"}'));
  expect(r.early).toBe('<b>hello</b>');
  expect(r.after).toBe('<b>hello</b>');
  expect(r.kept).toBe(true);
  expect(seen).toEqual([true]);
  expect(drawn).toEqual([{ text: 'hello' }]);
});

test('without the data in the page, the early script leaves the root to the script, which renders at mount', async () => {
  const r = await run(PAGE(''));
  expect(r.early).toBe('');
  expect(seen).toEqual([false]);
  expect(r.after).toBe('<b>from the API</b>');
});

test('a renderer that returns false or throws leaves the root to the script', async () => {
  const no = await run(PAGE('{"t":"x"}'), () => false);
  expect(no.early).toBe('');
  expect(seen).toEqual([false]);
  seen = [];
  const errors: unknown[] = [];
  const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((f: () => void) => { try { f(); } catch (e) { errors.push(e); } return 0; }) as never);
  try {
    const bad = await run(PAGE('{"t":"x"}'), () => { throw new Error('broken'); });
    expect(bad.after).toBe('<b>x</b>');
  } finally { timeout.mockRestore(); }
  expect(seen).toEqual([false]);
  expect(String(errors[0])).toContain('broken');
});

const files = (early: string | null): Record<string, string> => ({
  '/p/src/components/x-view.html': VIEW,
  '/p/src/components/x-view.ts': 'export class XView {}',
  ...(early === null ? {} : { '/p/src/components/x-view.early.ts': early }),
});
const build = (html: string, f: Record<string, string>) => compile(html, {
  file: '/p/page.html', root: '/p', dev: false, early: { module: null }, observe: true,
  readFile: (p) => { if (!(p in f)) throw new Error('missing'); return f[p]!; },
  helpers: { module: null, names: [], namespaces: {} },
});

test('only a page whose use renders early imports the renderer', () => {
  const on = build(PAGE('{"t":"a"}'), files('export default () => {};'));
  expect(on.diagnostics).toEqual([]);
  expect(on.early).toContain('import $er$x_view from "/src/components/x-view.early.ts";');
  // its props wait for data: nothing early of it
  const off = build(PAGE(null), files('export default () => {};'));
  expect(off.early ?? '').not.toContain('x-view.early');
  expect(earlyModule(null, { helpers: { module: null, names: [], namespaces: {} } })).toBeNull();
});

test('SN543: a script-filled component without an early renderer where its props are known early; SN312 for one with no default export', () => {
  const warn = build(PAGE('{"t":"a"}'), files(null)).diagnostics;
  expect(warn.map((d) => d.code)).toEqual(['SN543']);
  expect(warn[0]!.message).toMatch(/`<x-view>` is filled by its script at mount, after the first paint/);
  expect(warn[0]!.hint).toContain('/src/components/x-view.early.ts');
  // not where its props wait for data, nor for a root with content of its own, nor for a hidden root, which shows nothing
  expect(build(PAGE(null), files(null)).diagnostics).toEqual([]);
  expect(build(PAGE('{"t":"a"}'), { ...files(null), '/p/src/components/x-view.html': VIEW.replace('<div class="v"></div>', '<i hidden></i>') }).diagnostics).toEqual([]);
  expect(build(PAGE('{"t":"a"}'), { ...files(null), '/p/src/components/x-view.html': VIEW.replace('<div class="v"></div>', '<div class="v"><i>…</i></div>') }).diagnostics).toEqual([]);
  const none = build(PAGE('{"t":"a"}'), files('export const x = 1;')).diagnostics;
  expect(none.map((d) => d.code)).toEqual(['SN312']);
  expect(none[0]!.message).toMatch(/^the early renderer of `<x-view>` \(`\/src\/components\/x-view\.early\.ts`\) has no default export/);
});

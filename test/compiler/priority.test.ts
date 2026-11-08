// Request priority: a resource that only elements inside `<dialog>`s read is marked `lo` and
// requested with low priority; its preload link says so too.
import { expect, test } from 'vitest';
import { compile, compileParts, type CompileOptions } from '../../src/compiler/index.js';

const opts = (early = true): CompileOptions => ({ file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, ...(early ? { prerender: true, early: { module: null } } : {}) });
const page = (body: string) => `<!doctype html><html><head></head><body data-sn-state="{ sel: null, open: false }">${body}</body></html>`;
const lo = (html: string) => {
  const out = compileParts(page(html), opts());
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return { names: out.ir.resources.filter((r) => r.lo).map((r) => r.name), out };
};

test('a resource read only inside dialogs (directly, in a template of the dialog, by an action there) is low priority; one read outside, by a handler, by another resource or by a stream is not', () => {
  const { names, out } = lo(`
    <sn-resource name="user" src="/api/user"></sn-resource>
    <sn-resource name="tags" src="/api/tags"></sn-resource>
    <sn-resource name="labels" src="/api/labels" key="id"></sn-resource>
    <sn-resource name="dep" src="/api/dep?u={user.id}"></sn-resource>
    <sn-resource name="byHandler" src="/api/h"></sn-resource>
    <sn-resource name="byAction" src="/api/a"></sn-resource>
    <sn-resource name="byState" src="/api/s"></sn-resource>
    <sn-resource name="byStream" src="/api/st" key="id"></sn-resource>
    <sn-resource name="byMeta" src="/api/m"></sn-resource>
    <sn-resource name="unread" src="/api/un"></sn-resource>
    <sn-sync src="/events?t={byStream.length}"><sn-event name="e" resource="labels" op="refetch"></sn-event></sn-sync>
    <p data-sn-text="dep.x"></p>
    <button data-sn-on-click="sel = byHandler.id">h</button>
    <button data-sn-delete="/api/a/{byAction.id}">a</button>
    <div data-sn-state="{ n: byState.n }"><i data-sn-text="n"></i></div>
    <p data-sn-text="$meta.byMeta.loading"></p>
    <dialog id="d">
      <p data-sn-text="tags.length"></p>
      <template data-sn-for="l in labels"><li data-sn-text="l.name"></li></template>
      <template data-sn-if="open"><template data-sn-for="l in labels"><li data-sn-text="l.id"></li></template></template>
      <button data-sn-delete="/api/x/{user.id}" data-sn-then="sel = user">x</button>
    </dialog>`);
  expect(names).toEqual(['tags', 'labels', 'unread']);
  expect(out.ir.resources.find((r) => r.name === 'user')!.lo).toBeUndefined();
});

test('`then` on a resource and `when` are reads', () => {
  expect(lo(`
    <sn-resource name="a" src="/api/a"></sn-resource>
    <sn-resource name="b" src="/api/b" when="a.ok"></sn-resource>
    <sn-resource name="c" src="/api/c"></sn-resource>
    <sn-resource name="d" src="/api/d" then="sel = c.id"></sn-resource>
    <p data-sn-text="b.x + d.x"></p>`).names).toEqual([]);
});

test('the preload link of a low-priority resource carries fetchpriority="low", the early request `lo`; embedded data is never marked', () => {
  const { out } = lo(`
    <sn-resource name="user" src="/api/user"></sn-resource>
    <sn-resource name="tags" src="/api/tags"></sn-resource>
    <sn-resource name="detail" src="/api/d/{sel.id}" when="sel"></sn-resource>
    <sn-resource name="emb" src="/api/emb"></sn-resource>
    <p data-sn-text="user.name"></p>
    <dialog><p data-sn-text="tags.length + detail.x + emb.y"></p></dialog>`);
  const head = out.html.slice(0, out.html.indexOf('<body'));
  expect(head).toContain('<link rel="preload" as="fetch" crossorigin="" href="/api/user">');
  expect(head).toContain('<link rel="preload" as="fetch" crossorigin="" href="/api/tags" fetchpriority="low">');
  expect(out.early!.ir.res).toEqual([expect.objectContaining({ name: 'detail', lo: 1 })]);
});

test('embedded data: no request, so no mark', () => {
  const out = compileParts(`<!doctype html><html><head><script type="application/json" data-sn-data="emb">{"y":1}</script></head><body>
    <sn-resource name="emb" src="/api/emb"></sn-resource><dialog><p data-sn-text="emb.y"></p></dialog></body></html>`, opts(false));
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.ir.resources[0]!.lo).toBeUndefined();
});

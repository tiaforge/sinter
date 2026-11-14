// patch(item, …) and remove(item) act on the item in the resource it came from, found by its key
// (docs/proposals/components.md, "Store functions: resolved from the item").
import { describe, expect, test } from 'vitest';
import { mockRequests, render } from '../../src/testing/index.js';
import { compile } from '../../src/compiler/index.js';

const MAIL = [{ id: 1, s: 'one', f: false }, { id: 2, s: 'two', f: false }];
const texts = (root: HTMLElement, sel: string) => [...root.querySelectorAll(sel)].map((e) => e.textContent);
const errors = (html: string, files: Record<string, string> = {}) => compile(html, {
  file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: ['visible', 'merge'], namespaces: {} },
  readFile: (p) => { if (p in files) return files[p]!; throw new Error('missing'); },
}).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

describe('patch(item) and remove(item)', () => {
  test('a row, a row through a helper, an element, a let found by key, state assigned from a row', async () => {
    const requests = mockRequests({ 'GET /api/m': MAIL });
    const { root, settle, flush } = await render(`
      <sn-resource name="messages" src="/api/m" key="id"></sn-resource>
      <div data-sn-state="{ q: '', sel: null, openId: 2 }" data-sn-let="{ open: messages.find((m) => m.id === openId) }">
        <ul><template data-sn-for="m in visible(messages, q)"><li data-sn-on-click="patch(m, { f: !m.f })" data-sn-text="m.s + (m.f ? '!' : '')"></li></template></ul>
        <button id="first" data-sn-on-click="patch(messages[0], { s: 'first' })"></button>
        <button id="open" data-sn-on-click="patch(open, { s: 'open' })"></button>
        <button id="pick" data-sn-on-click="sel = messages[1]"></button>
        <button id="drop" data-sn-on-click="remove(sel); sel = null"></button>
      </div>`, { requests, helpers: { visible: (l: Array<{ s: string }>, q: string) => l.filter((x) => x.s.includes(q)) } });
    await settle();
    (root.querySelector('li') as HTMLElement).click(); await flush();
    expect(texts(root, 'li')).toEqual(['one!', 'two']);
    (root.querySelector('#first') as HTMLElement).click(); await flush();
    (root.querySelector('#open') as HTMLElement).click(); await flush();
    expect(texts(root, 'li')).toEqual(['first!', 'open']);
    (root.querySelector('#pick') as HTMLElement).click(); await flush();
    (root.querySelector('#drop') as HTMLElement).click(); await flush();
    expect(texts(root, 'li')).toEqual(['first!']);
  });

  test('a row of `cond ? a : b` is changed in the list it is shown from; a single resource is the item', async () => {
    const requests = mockRequests({ 'GET /api/feed': [{ id: 1, n: 0 }], 'GET /api/all': [{ id: 1, n: 0 }, { id: 2, n: 0 }], 'GET /api/one': { id: 9, n: 0 } });
    const { root, settle, flush } = await render(`
      <sn-resource name="feed" src="/api/feed" key="id"></sn-resource>
      <sn-resource name="all" src="/api/all" key="id"></sn-resource>
      <sn-resource name="one" src="/api/one"></sn-resource>
      <div data-sn-state="{ mine: true }">
        <button id="t" data-sn-on-click="mine = !mine"></button>
        <template data-sn-for="a in (mine ? feed : all)"><i data-sn-on-click="patch(a, { n: a.n + 1 })" data-sn-text="a.id + ':' + a.n"></i></template>
        <p data-sn-text="feed.map((x) => x.n).join() + '/' + all.map((x) => x.n).join()"></p>
        <b data-sn-on-click="patch(one, { n: one.n + 1 })" data-sn-text="one.n"></b>
        <s data-sn-on-click="remove(one)" data-sn-text="one === null ? 'gone' : 'here'"></s>
      </div>`, { requests });
    await settle();
    (root.querySelector('i') as HTMLElement).click(); await flush();
    expect(root.querySelector('p')!.textContent).toBe('1/0,0');
    (root.querySelector('#t') as HTMLElement).click(); await flush();
    (root.querySelectorAll('i')[1] as HTMLElement).click(); await flush();
    expect(root.querySelector('p')!.textContent).toBe('1/0,1');
    (root.querySelector('b') as HTMLElement).click(); await flush();
    expect(root.querySelector('b')!.textContent).toBe('1');
    (root.querySelector('s') as HTMLElement).click(); await flush();
    expect(root.querySelector('s')!.textContent).toBe('gone');
  });

  test('a prop keeps its provenance; so does an event detail that is one', async () => {
    const requests = mockRequests({ 'GET /api/m': MAIL });
    const { root, settle, flush } = await render(`
      <sn-resource name="messages" src="/api/m" key="id"></sn-resource>
      <ul><template data-sn-for="m in messages"><mail-row data-sn-prop="{ message: m }" data-sn-on-archive="remove($event.detail)"></mail-row></template></ul>`, {
      requests,
      components: { 'mail-row': `<template data-sn-component="{ message: { id: number; s: string; f: boolean } }" data-sn-emits="{ archive: unknown }">
  <li><b data-sn-on-click="patch(message, { f: true })" data-sn-text="message.s + (message.f ? '!' : '')"></b><button data-sn-on-click="emit('archive', message)">x</button></li>
</template>` },
    });
    await settle();
    (root.querySelector('b') as HTMLElement).click(); await flush();
    expect(texts(root, 'b')).toEqual(['one!', 'two']);
    (root.querySelectorAll('button')[1] as HTMLElement).click(); await flush();
    expect(texts(root, 'b')).toEqual(['one!']);
  });

  test('optimistic: the layer acts on the source and rolls back', async () => {
    const requests = mockRequests({ 'GET /api/m': MAIL, 'POST /api/flag': { status: 500 } });
    const { root, settle, flush } = await render(`
      <sn-resource name="messages" src="/api/m" key="id"></sn-resource>
      <template data-sn-for="m in messages"><i data-sn-post="/api/flag" data-sn-optimistic="patch(m, { f: true })" data-sn-catch="1" data-sn-text="m.f"></i></template>`, { requests });
    await settle();
    (root.querySelector('i') as HTMLElement).click(); await flush();
    expect(root.querySelector('i')!.textContent).toBe('true');
    await settle();
    expect(root.querySelector('i')!.textContent).toBe('false');
  });

  // with a nested list on the page, `patch()` runs in the nested module, which tries its sources the same way
  test.each([['', 'the core'], ['<template data-sn-for="f in folders"><template data-sn-for="x in f.subs" data-sn-key="x.id"><b data-sn-on-click="patch(x, { n: 1 })"></b></template></template>', 'the nested module']])(
    'resources keyed by other fields are passed over without a warning (strict mode, $1)', async (nested) => {
      const requests = mockRequests({ 'GET /api/m': MAIL, 'GET /api/f': [{ slug: 'inbox', subs: [] }], 'GET /api/t': [{ tag: 'x', n: 0 }] });
      const { root, settle, flush, warnings } = await render(`
        <sn-resource name="folders" src="/api/f" key="slug"></sn-resource>
        <sn-resource name="messages" src="/api/m" key="id"></sn-resource>
        <sn-resource name="tags" src="/api/t" key="tag"></sn-resource>
        <div data-sn-state="{ q: '', mine: true }">
          <ul><template data-sn-for="m in visible(messages, q)"><li data-sn-on-click="patch(m, { f: !m.f })" data-sn-text="m.s + (m.f ? '!' : '')"></li></template></ul>
          <template data-sn-for="a in (mine ? tags : messages)"><i data-sn-on-click="patch(a, { n: 1 })"></i></template>
          <button data-sn-on-click="mine = false" data-sn-text="folders.length"></button>
          <output data-sn-text="tags[0]?.n + '/' + messages[0]?.n"></output>
          ${nested}
        </div>`, { requests, strict: true, helpers: { visible: (l: Array<{ s: string }>, q: string) => l.filter((x) => x.s.includes(q)) } });
      await settle();
      const first = root.querySelector('li');
      first!.click(); await flush();
      expect(texts(root, 'li')).toEqual(['one!', 'two']);
      // the patched item keeps its row
      expect(root.querySelector('li')).toBe(first);
      (root.querySelector('i') as HTMLElement).click(); await flush();
      (root.querySelector('button') as HTMLElement).click(); await flush();
      (root.querySelector('i') as HTMLElement).click(); await flush();
      expect(root.querySelector('output')!.textContent).toBe('1/1');
      expect(warnings()).toEqual([]);
    });
});

describe('SN317', () => {
  const R = '<sn-resource name="messages" src="/api/m" key="id"></sn-resource><sn-resource name="other" src="/api/o" key="id"></sn-resource>';
  test('the forms with a resource name are removed', () => {
    expect(errors(`${R}<template data-sn-for="m in messages"><b data-sn-on-click="patch('messages', m, { f: 1 }); remove('messages', m)"></b></template>`)).toEqual([
      expect.stringMatching(/^SN317 `patch\(\)` takes the item, not a resource name: `patch\(m, \{ f: 1 \}\)` acts on the resource/),
      expect.stringMatching(/^SN317 `remove\(\)` takes the item, not a resource name: `remove\(m\)`/),
    ]);
  });
  test('an item with no source, state no handler assigns a row, a helper over two resources', () => {
    expect(errors(`${R}<div data-sn-state="{ x: null, y: { id: 1 } }"><b data-sn-on-click="patch({ id: 1 }, { f: 1 }); remove(y)"></b>
      <template data-sn-for="m in merge(messages, other)"><i data-sn-on-click="remove(m)"></i></template></div>`)).toEqual([
      expect.stringMatching(/^SN317 `\{ id: 1 \}` has no source/),
      expect.stringMatching(/^SN317 `m` comes from `merge\(\)`, which takes more than one resource/),
      expect.stringMatching(/^SN317 `y` has no source: no handler on this page assigns it/),
    ]);
  });
});

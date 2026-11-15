// Lets over helpers (docs/spec.md, Derived names): a `data-sn-let` entry, or a prop, that calls a
// helper is computed once per scope instance and again only when its dependencies change, unless
// every argument is an equal primitive (or a plain object of primitives); a let may wait for a helper
// module that reaches a lazy package; and the takeover of an early render changes nothing.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { firstPaint, mockRequests, mockStream, render } from '../../src/testing/index.js';

/** a helper that counts its calls and returns new objects each time, as a parser does */
const counting = () => {
  const calls: string[] = [];
  const parse = (s: string, o?: { upper?: boolean }) => { calls.push(s); return { words: String(s).split(' ').filter(Boolean).map((w) => ({ w: o?.upper ? w.toUpperCase() : w })) }; };
  return { calls, parse };
};

describe('a let over a helper is cached', () => {
  test('computed once per scope instance, however many bindings and handlers read it', async () => {
    const { calls, parse } = counting();
    const r = await render(`<main data-sn-state="{ src: 'a b', n: 0, seen: 0 }" data-sn-let="{ doc: parse(src) }">
      <p data-sn-text="doc.words.length"></p><ul><template data-sn-for="x in doc.words"><li data-sn-text="x.w"></li></template></ul>
      <button data-sn-on-click="seen = doc.words.length; n++" data-sn-text="n"></button></main>`, { helpers: { parse } });
    expect(calls).toEqual(['a b']);
    expect(r.root.querySelector('p')!.textContent).toBe('2');
    // a change it does not depend on, and a handler that reads it: no new call
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(r.root.querySelector('button')!.textContent).toBe('1');
    expect(r.state(r.root.querySelector('main')!).get().seen).toBe(2);
    expect(calls).toEqual(['a b']);
  });

  test('a dependency changes: computed again; equal primitive arguments return the last result', async () => {
    const { calls, parse } = counting();
    const r = await render(`<main data-sn-state="{ post: { body: 'a b', likes: 0 }, upper: false }" data-sn-let="{ doc: parse(post.body, { upper }) }">
      <ul><template data-sn-for="x in doc.words"><li data-sn-text="x.w"></li></template></ul>
      <span data-sn-text="post.likes"></span>
      <button id="like" data-sn-on-click="post.likes++; post = { ...post }"></button>
      <button id="edit" data-sn-on-click="post.body = 'c d e'"></button>
      <button id="up" data-sn-on-click="upper = true"></button></main>`, { helpers: { parse } });
    const li = () => [...r.root.querySelectorAll('li')];
    const first = li();
    // a new `post` object whose body is the same string: no parse, the same tree, the same rows
    r.root.querySelector<HTMLElement>('#like')!.click();
    await r.flush();
    expect(r.root.querySelector('span')!.textContent).toBe('1');
    expect(calls).toEqual(['a b']);
    expect(li()).toEqual(first);
    expect(li().every((x, i) => x === first[i])).toBe(true);
    // the body changes in place: parsed again
    r.root.querySelector<HTMLElement>('#edit')!.click();
    await r.flush();
    expect(calls).toEqual(['a b', 'c d e']);
    expect(li().map((x) => x.textContent)).toEqual(['c', 'd', 'e']);
    // an object literal of primitives that changed
    r.root.querySelector<HTMLElement>('#up')!.click();
    await r.flush();
    expect(calls).toEqual(['a b', 'c d e', 'c d e']);
    expect(li().map((x) => x.textContent)).toEqual(['C', 'D', 'E']);
  });

  test('an argument changed in place is not equal: computed again (state may be changed in place)', async () => {
    let calls = 0;
    const visible = (tasks: Array<{ t: string; done: boolean }>, q: string) => { calls++; return tasks.filter((x) => !x.done && x.t.includes(q)); };
    const r = await render(`<main data-sn-state="{ tasks: [{ t: 'a', done: false }], q: '' }" data-sn-let="{ shown: visible(tasks, q) }">
      <ul><template data-sn-for="x in shown"><li data-sn-text="x.t"></li></template></ul><b data-sn-text="shown.length"></b>
      <button id="add" data-sn-on-click="tasks.push({ t: 'ab', done: false })"></button>
      <button id="done" data-sn-on-click="tasks[0].done = true"></button></main>`, { helpers: { visible } });
    expect(calls).toBe(1);
    r.root.querySelector<HTMLElement>('#add')!.click();
    await r.flush();
    expect(calls).toBe(2);
    expect([...r.root.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['a', 'ab']);
    r.root.querySelector<HTMLElement>('#done')!.click();
    await r.flush();
    expect(calls).toBe(3);
    expect(r.root.querySelector('b')!.textContent).toBe('1');
  });

  test('per row: each row computes its own, once; a new row computes only its own', async () => {
    const { calls, parse } = counting();
    const r = await render(`<main data-sn-state="{ items: [{ id: 1, body: 'a' }, { id: 2, body: 'b c' }] }">
      <template data-sn-for="c in items" data-sn-key="c.id"><article data-sn-let="{ doc: parse(c.body) }"><b data-sn-text="doc.words.length"></b><i data-sn-text="doc.words[0].w"></i></article></template>
      <button id="add" data-sn-on-click="items.push({ id: 3, body: 'd e f' })"></button>
      <button id="like" data-sn-on-click="items[0] = { ...items[0], likes: 2 }"></button></main>`, { helpers: { parse } });
    expect(calls).toEqual(['a', 'b c']);
    expect([...r.root.querySelectorAll('b')].map((x) => x.textContent)).toEqual(['1', '2']);
    r.root.querySelector<HTMLElement>('#add')!.click();
    await r.flush();
    expect(calls).toEqual(['a', 'b c', 'd e f']);
    expect([...r.root.querySelectorAll('b')].map((x) => x.textContent)).toEqual(['1', '2', '3']);
    // a row's item replaced by a new object with the same body: computed again, the parse's last result
    r.root.querySelector<HTMLElement>('#like')!.click();
    await r.flush();
    expect(calls).toEqual(['a', 'b c', 'd e f']);
  });

  test('an <sn-sync> mapping reads the cached value', async () => {
    const { calls, parse } = counting();
    const stream = mockStream();
    const r = await render(`<main data-sn-state="{ src: 'a b', got: '' }" data-sn-let="{ doc: parse(src) }">
      <sn-sync src="/s"><sn-event name="ping" when="doc.words.length > 1" then="got = got + doc.words[0].w + n"></sn-event></sn-sync>
      <p data-sn-text="got + doc.words.length"></p></main>`, { helpers: { parse }, streams: { '/s': stream } });
    await r.settle();
    stream.emit('ping', { n: 1 });
    await r.settle();
    stream.emit('ping', { n: 2 });
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('a1a22');
    expect(calls).toEqual(['a b']);
  });

  test('a prop is a let: a prop over a helper is computed once for the component', async () => {
    const { calls, parse } = counting();
    const doc = '<template data-sn-component="{ doc: any }"><div><p data-sn-text="doc.words.length"></p><template data-sn-for="x in doc.words"><span data-sn-text="x.w"></span></template></div></template>';
    const r = await render(`<main data-sn-state="{ src: 'a b c', n: 0 }"><x-doc data-sn-prop="{ doc: parse(src) }"></x-doc><button data-sn-on-click="n++" data-sn-text="n"></button></main>`, { helpers: { parse }, components: { 'x-doc': doc } });
    expect(calls).toEqual(['a b c']);
    expect(r.root.querySelector('p')!.textContent).toBe('3');
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(calls).toEqual(['a b c']);
  });

  test('a namespace member is a helper too; a let without a helper call stays inlined', () => {
    const helpers = { module: '/src/sinter.helpers.ts', names: ['fmt'], namespaces: { crunch: { module: '/src/crunch.ts', members: ['parse'] } } };
    const out = compile(`<main data-sn-state="{ s: 'x' }" data-sn-let="{ a: crunch.parse(s), b: s.length, c: [s].map((v) => fmt(v)) }"><i data-sn-text="a"></i><i data-sn-text="b"></i><i data-sn-text="c"></i></main>`,
      { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: () => { throw new Error('none'); } });
    expect(out.module).toContain('$.$c($, 0, "$s0", ($) => ($.$h(0, crunch$parse, [$.$s0.s])))');
    // `b` reads no helper; `c` calls one only inside an arrow function: both inlined, as before
    expect(out.module).toContain('($) => ($.$s0.s.length)');
    expect(out.module).toContain('($) => (([$.$s0.s].map((v) => fmt(v))))');
    expect(out.module).toContain("import sn$lets from '@tiaforge-ui/sinter/lets';");
  });
});

describe('first paint and takeover', () => {
  const page = (let_: string) => `<!doctype html><html><head><script type="application/json" data-sn-data="post">${JSON.stringify({ body: 'a b c', tags: ['x'] })}</script></head><body>
    <sn-resource name="post" src="/api/post"></sn-resource>
    <main data-sn-state="{ rev: 0 }" data-sn-let="{ doc: ${let_} }"><button data-sn-on-click="rev++"></button><ul><template data-sn-for="x in doc.words"><li data-sn-text="x.w"></li></template></ul><p data-sn-text="doc.words.length"></p></main></body></html>`;

  test('the early script caches in its own copy: once per scope, however many bindings read it', async () => {
    const { calls, parse } = counting();
    await firstPaint(page("parse(post ? post.body : '')"), { helpers: { parse } });
    expect(calls).toEqual(['a b c']);
    expect([...document.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['a', 'b', 'c']);
    expect(document.querySelector('p')!.textContent).toBe('3');
  });

  for (const [what, expr, parses] of [
    ['equal primitive arguments: the page module parses once', "parse(post ? post.body : '', { rev })", 1],
    // the argument is the resource's object, which holds a list: computed again when the embedded data is
    // stored, new objects, adopted rows matched by position
    ['an object argument, new objects at every call: rows adopted by position', "parse(post ? post.body : '', { rev }, post)", 2],
  ] as const) {
    test(`the takeover changes nothing (${what})`, async () => {
      const { calls, parse } = counting();
      const changes: string[] = [];
      let early: Element[] = [];
      const watch = new MutationObserver((records) => {
        for (const x of records) {
          if (x.type === 'childList' && [...x.removedNodes, ...x.addedNodes].some((n) => n.nodeType === 1)) changes.push(`children of ${(x.target as Element).localName}`);
          if (x.type === 'characterData' && x.target.textContent !== x.oldValue) changes.push(`text ${x.oldValue} → ${x.target.textContent}`);
        }
      });
      const r = await render(page(expr), {
        helpers: { parse }, requests: mockRequests({ 'GET /api/post': { body: 'a b c', tags: ['x'] } }),
        firstPaint: { afterEarly: () => { early = [...document.querySelectorAll('li')]; calls.length = 0; watch.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true }); } },
      });
      await r.settle();
      watch.disconnect();
      expect(early.length).toBe(3);
      expect(changes).toEqual([]);
      const now = [...document.querySelectorAll('li')];
      expect(now.every((x, i) => x === early[i])).toBe(true);
      expect(calls.length).toBe(parses);
      // after the takeover, lists behave as today: new objects are new rows
      document.querySelector('button')!.click();
      await r.flush();
      if (parses === 2) expect([...document.querySelectorAll('li')][0]).not.toBe(early[0]);
      expect([...document.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['a', 'b', 'c']);
    });
  }
});

describe('a let may wait for a lazy helper module', () => {
  const lazyMod = (load?: () => Promise<Record<string, unknown>>) => {
    let open!: (m: Record<string, unknown>) => void, fail!: (e: unknown) => void;
    const calls: string[] = [];
    const mod = { parse: (s: string) => { calls.push(s); return { words: s.split(' ').map((w) => ({ w })) }; } };
    const arrived = new Promise<Record<string, unknown>>((ok, ko) => { open = ok; fail = ko; });
    return { calls, mod, open: () => open(mod), fail, helpers: { crunch: { members: ['parse'], load: load ?? (() => arrived) } } };
  };
  const page = `<main data-sn-state="{ src: 'a b' }" data-sn-let="{ doc: crunch.parse(src) }">
    <template data-sn-if="doc"><ul><template data-sn-for="x in doc.words"><li data-sn-text="x.w"></li></template></ul></template>
    <template data-sn-else><p>Loading…</p></template><b data-sn-text="text.count(src)"></b>
    <button data-sn-on-click="src = 'c d e'"></button></main>`;

  test('undefined until the module arrives; its arrival renders what reads the let; a module without the package stays ordinary', async () => {
    const m = lazyMod();
    const r = await render(page, { lazyHelpers: m.helpers, helpers: { text: { count: (s: string) => s.split(' ').length } } });
    expect(r.root.querySelector('p')?.textContent).toBe('Loading…');
    expect(r.root.querySelector('b')!.textContent).toBe('2');
    m.open();
    await r.settle();
    expect(r.root.querySelector('p')).toBeNull();
    expect([...r.root.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['a', 'b']);
    r.root.querySelector('button')!.click();
    await r.flush();
    expect([...r.root.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['c', 'd', 'e']);
    expect(m.calls).toEqual(['a b', 'c d e']);
  });

  test('a failed load takes the unhandled-error path, once; the let stays undefined', async () => {
    const m = lazyMod(() => Promise.reject(new Error('offline')));
    const errors: string[] = [];
    const on = (e: Event) => { errors.push((e as CustomEvent).detail.error.message); e.preventDefault(); };
    document.addEventListener('sn-error', on);
    try {
      const r = await render(page, { lazyHelpers: m.helpers, helpers: { text: { count: (s: string) => s.split(' ').length } } });
      await r.settle();
      r.root.querySelector('button')!.click();
      await r.settle();
      expect(errors).toEqual(['offline']);
      expect(r.root.querySelector('p')?.textContent).toBe('Loading…');
    } finally { document.removeEventListener('sn-error', on); }
  });

  test('a waiting let is not early; the rest renders early', async () => {
    const m = lazyMod();
    await firstPaint(`<main data-sn-state="{ src: 'a b' }" data-sn-let="{ doc: crunch.parse(src) }"><h1 data-sn-text="src"></h1><p data-sn-text="doc ? doc.words.length : 'later'"></p></main>`, { lazyHelpers: m.helpers });
    expect(document.querySelector('h1')!.textContent).toBe('a b');
    expect(document.querySelector('p')!.textContent).toBe('');
    expect(m.calls).toEqual([]);
  });

  test('SN324 per module: anywhere but a let or a prop, with the hint; the module is not imported by the page', async () => {
    const m = lazyMod();
    await expect(render('<main data-sn-state="{ src: \'a\' }"><p data-sn-text="crunch.parse(src).words.length"></p></main>', { lazyHelpers: m.helpers }))
      .rejects.toThrow(/SN324.*`crunch\.parse` is declared in a module that reaches a lazy package/s);
    await expect(render('<main data-sn-state="{ src: \'a\', n: 0 }"><button data-sn-on-click="n = crunch.parse(src).words.length"></button></main>', { lazyHelpers: m.helpers }))
      .rejects.toThrow(/SN324/);
    await expect(render('<main data-sn-state="{ n: crunch.parse(\'a\') }"></main>', { lazyHelpers: m.helpers })).rejects.toThrow(/SN324/);
    // a prop waits like a let
    const r = await render(`<main data-sn-state="{ src: 'a b c' }"><x-n data-sn-prop="{ doc: crunch.parse(src) }"></x-n></main>`,
      { lazyHelpers: m.helpers, components: { 'x-n': '<template data-sn-component="{ doc?: any }"><p data-sn-text="doc ? doc.words.length : \'…\'"></p></template>' } });
    expect(r.root.querySelector('p')!.textContent).toBe('…');
    m.open();
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('3');
    // the compiled page: the module is loaded by a function of the table, never imported
    const helpers = { module: '/src/sinter.helpers.ts', names: [], namespaces: { crunch: { module: '/src/lib/crunch.ts', members: ['parse', 'headings'] }, toc: { module: '/src/lib/toc.ts', members: ['list'] } } };
    const out = compile('<main data-sn-state="{ s: \'x\' }" data-sn-let="{ doc: crunch.parse(s) }"><i data-sn-text="doc"></i><b data-sn-text="toc.list(s)"></b></main>',
      { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: () => { throw new Error('none'); }, lazyModule: (x) => (x === '/src/lib/crunch.ts' ? ['fakelib'] : []) });
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(out.module).not.toMatch(/import \{[^}]*parse[^}]*\} from "\/src\/lib\/crunch\.ts"/);
    expect(out.module).toContain('import { list as toc$list } from "/src/lib/toc.ts";');
    expect(out.module).toContain('const $lh$0 = $laterH(() => import("/src/lib/crunch.ts"), [$lp$0], "__SN_CHUNK__/p/src/lib/crunch.ts__", import.meta.url);');
    expect(out.module).toContain('$.$z(0, "parse")');
  });
});

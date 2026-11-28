// Lets over helpers (docs/spec.md, Derived names): a `data-sn-let` entry, or a prop, is its expression. A let
// that calls something is computed once until state may have changed (the let cache, src/lets.ts); a prop, and
// a let in a handler, are inlined at every read (an expensive helper is the app's to memoize, `memo()`).
// What a binding, a handler and a listener read is what the expression gives then: after the handler's own
// writes, store functions, emit(), nested events, in the middle of a flush, after the takeover of an early
// render; a let may wait for a helper module that reaches a lazy package.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { firstPaint, mockRequests, mockStream, render } from '../../src/testing/index.js';
import { configure } from '../../src/index.js';
import { memo } from '../../src/memo.js';

/** a helper that records its calls and returns new objects each time, as a parser does */
const counting = () => {
  const calls: string[] = [];
  const parse = (s: string, o?: { upper?: boolean }) => { calls.push(s); return { words: String(s).split(' ').filter(Boolean).map((w) => ({ w: o?.upper ? w.toUpperCase() : w })) }; };
  return { calls, parse };
};

describe('a let over a helper: its expression, at every read', () => {
  test('bindings and a handler read it', async () => {
    const { parse } = counting();
    const r = await render(`<main data-sn-state="{ src: 'a b', n: 0, seen: 0 }" data-sn-let="{ doc: parse(src) }">
      <p data-sn-text="doc.words.length"></p><ul><template data-sn-for="x in doc.words"><li data-sn-text="x.w"></li></template></ul>
      <button data-sn-on-click="seen = doc.words.length; n++" data-sn-text="n"></button></main>`, { helpers: { parse } });
    expect(r.root.querySelector('p')!.textContent).toBe('2');
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(r.root.querySelector('button')!.textContent).toBe('1');
    expect(r.state(r.root.querySelector('main')!).get().seen).toBe(2);
  });

  // a handler's writes are marked when it returns: a read later in the same handler must see them
  for (const [what, state, let_, handler, seen] of [
    ['a list changed in place', '{ xs: [1, 2], seen: 0 }', '{ total: sum(xs) }', 'xs.push(10); seen = total', 13],
    ['a list replaced', '{ xs: [1, 2, 10], seen: 0 }', '{ total: sum(xs) }', 'xs = [...xs, 5]; seen = total', 18],
    ['an object changed in place, read through a member', '{ o: { xs: [1] }, seen: 0 }', '{ n: len(o) }', 'o.xs.push(1); seen = n', 2],
  ] as const) {
    test(`a handler that changes a let's inputs and then reads it sees the new value (${what})`, async () => {
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const len = (o: { xs: unknown[] }) => o.xs.length;
      const name = let_.slice(2, let_.indexOf(':'));
      const r = await render(`<main data-sn-state="${state}" data-sn-let="${let_}"><p data-sn-text="${name}"></p><b data-sn-text="seen"></b>
        <button data-sn-on-click="${handler}"></button></main>`, { helpers: { sum, len } });
      const before = r.root.querySelector('p')!.textContent;
      r.root.querySelector('button')!.click();
      await r.flush();
      expect(r.root.querySelector('b')!.textContent).toBe(String(seen));
      // the binding agrees
      expect(r.root.querySelector('p')!.textContent).toBe(String(seen));
      expect(before).not.toBe(String(seen));
    });
  }

  test('100 mousemoves whose handler writes something else and reads the let three times', async () => {
    const decorate = (xs: Array<{ n: number }>) => xs.map((x) => ({ ...x }));
    const count = (v: unknown[]) => v.length;
    const r = await render(`<main data-sn-state="{ xs: [{ n: 1 }, { n: 2 }], hover: 0, seen: 0 }" data-sn-let="{ view: decorate(xs), total: count(view) }"
      data-sn-on-mousemove="hover = $event.clientX; seen = total + view.length + total"><i data-sn-text="total"></i><b data-sn-text="seen"></b></main>`, { helpers: { decorate, count } });
    const main = r.root.querySelector('main')!;
    for (let i = 0; i < 100; i++) main.dispatchEvent(new MouseEvent('mousemove', { clientX: i, bubbles: true }));
    await r.flush();
    expect(r.root.querySelector('b')!.textContent).toBe('6');
  });

  // what changes a let's inputs outside the handler's own writes
  describe('a let read in a handler after something else changed what it reads', () => {
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const dbl = (a: number) => ({ v: a * 2 });
    const todos = () => mockRequests({ 'GET /api/todos': [{ id: 1, n: 1 }, { id: 2, n: 2 }] });
    for (const [what, handler, want] of [
      ['merge()', 'merge(x, { n: 10 }); o = T', '12'],
      ['remove()', 'remove(x); o = T', '2'],
      ['upsert(todos, …)', 'upsert(todos, { id: 3, n: 100 }); o = T', '103'],
    ] as const) {
      test(`a store function: ${what}`, async () => {
        const r = await render(`<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>
          <main data-sn-state="{ o: 0 }" data-sn-let="{ T: sum(todos.map((x) => x.n)) }"><p data-sn-text="T"></p><b data-sn-text="o"></b>
          <template data-sn-for="x in todos" data-sn-key="x.id"><button data-sn-on-click="${handler}"></button></template></main>`, { helpers: { sum }, requests: todos() });
        await r.settle();
        expect(r.root.querySelector('p')!.textContent).toBe('3');
        r.root.querySelector('button')!.click();
        await r.flush();
        expect(r.root.querySelector('b')!.textContent).toBe(want);
      });
    }

    test('emit(), the listener writes', async () => {
      const r = await render(`<main data-sn-state="{ a: 1, o: 0 }" data-sn-let="{ L: dbl(a) }" data-sn-on-bump="a = 5"><p data-sn-text="L.v"></p><b data-sn-text="o"></b>
        <button data-sn-on-click="emit('bump'); o = L.v"></button></main>`, { helpers: { dbl } });
      r.root.querySelector('button')!.click();
      await r.flush();
      expect(r.root.querySelector('b')!.textContent).toBe('10');
    });

    test('emit(), the listener reads', async () => {
      const r = await render(`<main data-sn-state="{ a: 1, o: 0 }" data-sn-let="{ L: dbl(a) }" data-sn-on-ping="o = L.v"><p data-sn-text="L.v"></p><b data-sn-text="o"></b>
        <button data-sn-on-click="a = 5; emit('ping')"></button></main>`, { helpers: { dbl } });
      r.root.querySelector('button')!.click();
      await r.flush();
      expect(r.root.querySelector('b')!.textContent).toBe('10');
    });

    test('a component emits, its parent writes the prop its let reads', async () => {
      const r = await render(`<main data-sn-state="{ a: 1 }"><x-c data-sn-with="{ a }" data-sn-on-bump="a = 5"></x-c></main>`, {
        helpers: { dbl },
        components: { 'x-c': `<template data-sn-props="{ a: number }" data-sn-emits="{ bump: null }"><div data-sn-state="{ o: 0 }" data-sn-let="{ L: dbl(a) }">
          <p data-sn-text="L.v"></p><b data-sn-text="o"></b><button data-sn-on-click="emit('bump'); o = L.v"></button></div></template>` },
      });
      r.root.querySelector('button')!.click();
      await r.flush();
      expect(r.root.querySelector('b')!.textContent).toBe('10');
    });

    test('a synchronous DOM event whose handler writes', async () => {
      const r = await render(`<main data-sn-state="{ a: 1, o: 0 }" data-sn-let="{ L: dbl(a) }"><p data-sn-text="L.v"></p><b data-sn-text="o"></b>
        <input data-sn-on-focus="a = 5"><button data-sn-on-click="$el.previousElementSibling.focus(); o = L.v"></button></main>`, { helpers: { dbl } });
      r.root.querySelector('button')!.click();
      await r.flush();
      expect(r.root.querySelector('b')!.textContent).toBe('10');
    });

    test('two scripted clicks in a row, a write and then a read, before any flush', async () => {
      const r = await render(`<main data-sn-state="{ a: 1, o: 0 }" data-sn-let="{ L: dbl(a) }"><p data-sn-text="L.v"></p><b data-sn-text="o"></b>
        <button id="w" data-sn-on-click="a = 5"></button><button id="r" data-sn-on-click="o = L.v"></button></main>`, { helpers: { dbl } });
      r.root.querySelector<HTMLElement>('#w')!.click();
      r.root.querySelector<HTMLElement>('#r')!.click();
      await r.flush();
      expect(r.root.querySelector('b')!.textContent).toBe('10');
    });

    // a read before the handler's own write, and after it
    for (const [what, state, let_, handler, want] of [
      ['read, write, read', '{ a: 1, r: 0, r2: 0 }', '{ L: dbl(a) }', 'r = L.v; a = 5; r2 = L.v', 'r=2 r2=10'],
      ['a total before and after a push', '{ xs: [1, 2], before: 0, added: 0 }', '{ total: sum(xs) }', 'before = total; xs.push(4); added = total - before', 'before=3 added=4'],
      ['a conditional push between two reads', '{ xs: [1, 2], msg: 0 }', '{ total: sum(xs) }', 'total < 10 && (xs.push(9), msg = total)', 'msg=12'],
      ['three reads with two writes between', '{ a: 1, r: 0, r2: 0, r3: 0 }', '{ L: dbl(a) }', 'r = L.v; a = 2; r2 = L.v; a = 3; r3 = L.v', 'r=2 r2=4 r3=6'],
    ] as const) {
      test(`a read before the handler's own write, and after it (${what})`, async () => {
        const out = want.split(' ').map((x) => x.split('=')[0]!);
        const r = await render(`<main data-sn-state="${state}" data-sn-let="${let_}"><p data-sn-text="${let_.slice(2, let_.indexOf(':'))}${let_.includes('dbl') ? '.v' : ''}"></p>
          ${out.map((k) => `<b class="${k}" data-sn-text="${k}"></b>`).join('')}<button data-sn-on-click="${handler}"></button></main>`, { helpers: { sum, dbl } });
        r.root.querySelector('button')!.click();
        await r.flush();
        expect(out.map((k) => `${k}=${r.root.querySelector(`b.${k}`)!.textContent}`).join(' ')).toBe(want);
      });
    }

    test('a handler run in the middle of a flush (an island\'s event from a prop setter, writing a row) does not disturb the running walk\'s other rows', async () => {
      class XPing extends HTMLElement {
        set n(v: number) { if (v > 0) this.dispatchEvent(new CustomEvent('ping', { bubbles: true })); }
      }
      if (!customElements.get('x-ping')) customElements.define('x-ping', XPing);
      const r = await render(`<main data-sn-state="{ go: 0, k: 1, xs: [{ s: 0 }, { s: 2 }, { s: 0 }] }" data-sn-let="{ T: sum(xs.map((x) => x.s)), U: dbl(k) }" data-sn-on-ping="xs[1].s = 2">
        <x-ping data-sn-with="{ n: go }"></x-ping><b data-sn-text="U.v + go"></b><p data-sn-text="T"></p>
        <ul><template data-sn-for="x in xs"><li data-sn-text="x.s"></li></template></ul><i data-sn-text="T + go"></i>
        <button data-sn-on-click="xs[0].s = 7; xs[2].s = 9; go = 1"></button></main>`, { helpers: { sum, dbl } });
      r.root.querySelector('button')!.click();
      await r.flush();
      expect([...r.root.querySelectorAll('li')].map((x) => x.textContent).join(',')).toBe('7,2,9');
      expect(r.root.querySelector('p')!.textContent).toBe('18');
      expect(r.root.querySelector('i')!.textContent).toBe('19');
    });

  });

  test('a dependency changes: the rows show the new value; an object literal argument that changed', async () => {
    const { parse } = counting();
    const r = await render(`<main data-sn-state="{ post: { body: 'a b', likes: 0 }, upper: false }" data-sn-let="{ doc: parse(post.body, { upper }) }">
      <ul><template data-sn-for="x in doc.words"><li data-sn-text="x.w"></li></template></ul>
      <span data-sn-text="post.likes"></span>
      <button id="like" data-sn-on-click="post.likes++; post = { ...post }"></button>
      <button id="edit" data-sn-on-click="post.body = 'c d e'"></button>
      <button id="up" data-sn-on-click="upper = true"></button></main>`, { helpers: { parse } });
    const li = () => [...r.root.querySelectorAll('li')];
    r.root.querySelector<HTMLElement>('#like')!.click();
    await r.flush();
    expect(r.root.querySelector('span')!.textContent).toBe('1');
    expect(li().map((x) => x.textContent)).toEqual(['a', 'b']);
    // the body changes in place
    r.root.querySelector<HTMLElement>('#edit')!.click();
    await r.flush();
    expect(li().map((x) => x.textContent)).toEqual(['c', 'd', 'e']);
    // an object literal of primitives that changed
    r.root.querySelector<HTMLElement>('#up')!.click();
    await r.flush();
    expect(li().map((x) => x.textContent)).toEqual(['C', 'D', 'E']);
  });

  test('an argument changed in place: the new value', async () => {
    const visible = (tasks: Array<{ t: string; done: boolean }>, q: string) => tasks.filter((x) => !x.done && x.t.includes(q));
    const r = await render(`<main data-sn-state="{ tasks: [{ t: 'a', done: false }], q: '' }" data-sn-let="{ shown: visible(tasks, q) }">
      <ul><template data-sn-for="x in shown"><li data-sn-text="x.t"></li></template></ul><b data-sn-text="shown.length"></b>
      <button id="add" data-sn-on-click="tasks.push({ t: 'ab', done: false })"></button>
      <button id="done" data-sn-on-click="tasks[0].done = true"></button></main>`, { helpers: { visible } });
    r.root.querySelector<HTMLElement>('#add')!.click();
    await r.flush();
    expect([...r.root.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['a', 'ab']);
    r.root.querySelector<HTMLElement>('#done')!.click();
    await r.flush();
    expect(r.root.querySelector('b')!.textContent).toBe('1');
  });

  test('per row: each row its own value; a new row, a row replaced', async () => {
    const { parse } = counting();
    const r = await render(`<main data-sn-state="{ items: [{ id: 1, body: 'a' }, { id: 2, body: 'b c' }] }">
      <template data-sn-for="c in items" data-sn-key="c.id"><article data-sn-let="{ doc: parse(c.body) }"><b data-sn-text="doc.words.length"></b><i data-sn-text="doc.words[0].w"></i></article></template>
      <button id="add" data-sn-on-click="items.push({ id: 3, body: 'd e f' })"></button>
      <button id="like" data-sn-on-click="items[0] = { ...items[0], likes: 2 }"></button></main>`, { helpers: { parse } });
    expect([...r.root.querySelectorAll('b')].map((x) => x.textContent)).toEqual(['1', '2']);
    r.root.querySelector<HTMLElement>('#add')!.click();
    await r.flush();
    expect([...r.root.querySelectorAll('b')].map((x) => x.textContent)).toEqual(['1', '2', '3']);
    r.root.querySelector<HTMLElement>('#like')!.click();
    await r.flush();
    expect([...r.root.querySelectorAll('i')].map((x) => x.textContent)).toEqual(['a', 'b', 'd']);
  });

  test('an <sn-sync> mapping reads the let', async () => {
    const { parse } = counting();
    const stream = mockStream();
    const r = await render(`<main data-sn-state="{ src: 'a b', got: '' }" data-sn-let="{ doc: parse(src) }">
      <sn-sync src="/s"><sn-event name="ping" when="doc.words.length > 1" then="got = got + doc.words[0].w + $event.n"></sn-event></sn-sync>
      <p data-sn-text="got + doc.words.length"></p></main>`, { helpers: { parse }, streams: { '/s': stream } });
    await r.settle();
    stream.emit('ping', { n: 1 });
    await r.settle();
    stream.emit('ping', { n: 2 });
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('a1a22');
  });

  test('a prop is a let: a prop over a helper', async () => {
    const { parse } = counting();
    const doc = '<template data-sn-props="{ doc: any }"><div><p data-sn-text="doc.words.length"></p><template data-sn-for="x in doc.words"><span data-sn-text="x.w"></span></template></div></template>';
    const r = await render(`<main data-sn-state="{ src: 'a b c', n: 0 }"><x-doc data-sn-with="{ doc: parse(src) }"></x-doc><button data-sn-on-click="n++" data-sn-text="n"></button></main>`, { helpers: { parse }, components: { 'x-doc': doc } });
    expect(r.root.querySelector('p')!.textContent).toBe('3');
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(r.root.querySelector('p')!.textContent).toBe('3');
  });

  test('`letCache: false`: a let over a helper compiles inlined, as any let: no cache, no feature module', () => {
    const helpers = { module: '/src/sinter.helpers.ts', names: ['fmt'], namespaces: { crunch: { module: '/src/crunch.ts', members: ['parse'] } } };
    const out = compile(`<main data-sn-state="{ s: 'x' }" data-sn-let="{ a: crunch.parse(s), b: s.length, c: [s].map((v) => fmt(v)) }"><i data-sn-text="a"></i><i data-sn-text="b"></i><i data-sn-text="c"></i></main>`,
      { file: '/p/index.html', root: '/p', dev: false, helpers, letCache: false, readFile: () => { throw new Error('none'); } });
    expect(out.module).toContain('crunch$parse($.$s0.s)');
    expect(out.module).toContain('($) => ($.$s0.s.length)');
    expect(out.module).toContain('($) => (([$.$s0.s].map((v) => fmt(v))))');
    expect(out.module).not.toContain('$.$l(');
    expect(out.module).not.toContain('sinter/runtime/lets');
  });
});

describe('the let cache: a let that calls something is computed once until state may have changed', () => {
  const out = (html: string, o: object = {}) => compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: '/src/sinter.helpers.ts', names: ['fmt', 'parse'], namespaces: {} }, readFile: () => { throw new Error('none'); }, ...o });

  test('what compiles to the cache: a let that calls; not one that only reads, reads `$el`, or a prop', () => {
    const m = out(`<main data-sn-state="{ s: 'x' }" data-sn-let="{ a: fmt(s), b: s.length, c: fmt($el.id), d: fmt(a) + b }"><i data-sn-text="a"></i><i data-sn-text="b"></i><i id="q" data-sn-text="c"></i><i data-sn-text="d"></i>
      <button data-sn-on-click="s = a + d"></button></main>`).module;
    expect(m).toContain('($) => ($.$l($, 0, ($) => (fmt($.$s0.s))))');
    expect(m).toContain('($) => ($.$s0.s.length)');
    expect(m).toContain('($) => ((fmt($.$el.id)))');
    // a let over a let: the inner one is read through the cache too; the names each reads off its scope
    expect(m).toContain('($) => ($.$l($, 1, ($) => (fmt($.$l($, 0, ($) => (fmt($.$s0.s)))) + $.$s0.s.length)))');
    expect(m).toContain('"lc":[["$s0"],["$s0"]]');
    // a handler reads lets as written
    expect(m).toContain('$.$s0.s = (fmt($.$s0.s)) + (fmt((fmt($.$s0.s))) + $.$s0.s.length)');
    expect(m).toContain('sinter/runtime/lets');
  });

  test('an expression that may change what a let gives (a mutator, an unknown method) reads it as written', async () => {
    const m = out(`<main data-sn-state="{ xs: [3, 1, 2] }" data-sn-let="{ h: xs.filter((x) => x > 1) }"><i data-sn-text="h.reverse()[0]"></i><b data-sn-text="h.length + Math.max(0, h[0])"></b><u data-sn-text="Object.assign(h, { 0: 9 })[0]"></u></main>`).module;
    expect(m).toContain('($) => (($.$s0.xs.filter((x) => x > 1)).reverse()[0])');
    expect(m).toContain('($) => (Object.assign(($.$s0.xs.filter((x) => x > 1)), { 0: 9 })[0])');
    expect(m).toContain('($) => ($.$l($, 0, ($) => ($.$s0.xs.filter((x) => x > 1))).length + Math.max(0, $.$l($, 0, ($) => ($.$s0.xs.filter((x) => x > 1)))[0]))');
    const pick = (xs: number[]) => xs.filter((x) => x > 1);
    const r = await render(`<main data-sn-state="{ xs: [3, 1, 2] }" data-sn-let="{ h: pick(xs) }"><i data-sn-text="h.reverse()[0]"></i><b data-sn-text="h[0]"></b><u data-sn-text="h.reverse()[0]"></u></main>`, { helpers: { pick } });
    expect(r.root.querySelector('main')!.textContent).toBe('232');
  });

  test('the early file reads a cached let inlined', () => {
    const r = out(`<!doctype html><html><head><script type="application/json" data-sn-resource="post">{"body":"a"}</script></head><body><sn-resource name="post" src="/api/post"></sn-resource>
      <main data-sn-let="{ a: fmt(post ? post.body : '') }"><i data-sn-text="a"></i><b data-sn-text="a + a"></b></main></body></html>`, { early: true });
    expect(r.module).toContain('$.$l($, 0, ');
    expect(JSON.stringify(r.early ?? '')).not.toContain('$l(');
    expect(JSON.stringify(r.early ?? '')).not.toContain('/*L');
  });

  test('several bindings read one let: one call a change, and only when something reads it', async () => {
    for (const letCache of [true, false]) {
      const { calls, parse } = counting();
      const r = await render(`<main data-sn-state="{ src: 'a b', n: 0 }" data-sn-let="{ doc: parse(src) }">
        <p data-sn-text="doc.words.length"></p><i data-sn-text="doc.words[0].w"></i><b data-sn-text="doc.words.length + n"></b>
        <button id="n" data-sn-on-click="n++"></button><button id="s" data-sn-on-click="src = src + ' c'"></button></main>`, { helpers: { parse }, letCache });
      expect(calls.length).toBe(letCache ? 1 : 3);
      r.root.querySelector<HTMLElement>('#n')!.click();
      await r.flush();
      expect(calls.length).toBe(letCache ? 2 : 4);
      r.root.querySelector<HTMLElement>('#s')!.click();
      await r.flush();
      expect(calls.length).toBe(letCache ? 3 : 7);
      expect(r.root.querySelector('p')!.textContent + r.root.querySelector('i')!.textContent + r.root.querySelector('b')!.textContent).toBe('3a4');
    }
  });

  test('a let around a list, read in every row: one call for all the rows; a row\'s own let: one a row', async () => {
    const calls: string[] = [];
    const total = (xs: number[]) => { calls.push('total'); return xs.reduce((a, b) => a + b, 0); };
    const share = (x: number, t: number) => { calls.push('share' + x); return Math.round(100 * x / t); };
    const r = await render(`<main data-sn-state="{ xs: [1, 3, 4], k: 0 }" data-sn-let="{ T: total(xs) }">
      <template data-sn-for="x in xs"><p data-sn-let="{ S: share(x, T) }"><i data-sn-text="S"></i><b data-sn-text="S + '%' + k"></b><u data-sn-attr="{ title: T + '/' + S }"></u></p></template>
      <button id="k" data-sn-on-click="k++"></button><button id="x" data-sn-on-click="xs = [1, 3, 4, 2]"></button></main>`, { helpers: { total, share } });
    expect(calls.filter((c) => c == 'total').length).toBe(1);
    expect(calls.filter((c) => c != 'total').sort()).toEqual(['share1', 'share3', 'share4']);
    calls.length = 0;
    r.root.querySelector<HTMLElement>('#k')!.click();
    await r.flush();
    // each row's <b> reads S again: once a row; T once
    expect(calls.sort()).toEqual(['share1', 'share3', 'share4', 'total']);
    calls.length = 0;
    r.root.querySelector<HTMLElement>('#x')!.click();
    await r.flush();
    expect([...r.root.querySelectorAll('i')].map((x) => x.textContent)).toEqual(['10', '30', '40', '20']);
    expect(calls.filter((c) => c == 'total').length).toBe(1);
  });

  test('a kept row that takes another item (rows keyed by index): its let is the new item\'s', async () => {
    const tag = (s: string) => '<' + s + '>';
    const r = await render(`<main data-sn-state="{ xs: ['a', 'b', 'c'] }">
      <template data-sn-for="(x, i) in xs" data-sn-key="i"><p data-sn-let="{ L: tag(x) }"><i data-sn-text="L"></i><b data-sn-text="L + i"></b></p></template>
      <button data-sn-on-click="xs = ['c', 'a']"></button></main>`, { helpers: { tag } });
    r.root.querySelector('button')!.click();
    await r.flush();
    expect([...r.root.querySelectorAll('p')].map((x) => x.textContent)).toEqual(['<c><c>0', '<a><a>1']);
  });

  test('a handler reads the let between its own writes, and what `run()` sends after a write, as written', async () => {
    const { parse } = counting();
    const requests = mockRequests({ 'POST /api/send': { ok: true } });
    const r = await render(`<main data-sn-state="{ src: 'a b', a: 0, b: 0 }" data-sn-let="{ doc: parse(src) }"><p data-sn-text="doc.words.length"></p>
      <span hidden id="send" data-sn-post="/api/send" data-sn-body="{ n: doc.words.length }"></span>
      <button data-sn-on-click="run('send'); a = doc.words.length; src = 'x y z'; b = doc.words.length; run('send')"></button></main>`, { helpers: { parse }, requests });
    r.root.querySelector('button')!.click();
    await r.settle();
    const st = r.state(r.root.querySelector('main')!).get();
    expect([st.a, st.b]).toEqual([2, 3]);
    expect(requests.calls.map((c) => c.body)).toEqual([{ n: 2 }, { n: 3 }]);
    expect(r.root.querySelector('p')!.textContent).toBe('3');
  });

  test('a let that throws keeps nothing: each reader warns, and the next change computes it again', async () => {
    let n = 0;
    const risky = (s: string) => { n++; if (s == 'bad') throw new Error('no'); return s.toUpperCase(); };
    const r = await render(`<main data-sn-state="{ s: 'bad' }" data-sn-let="{ L: risky(s) }"><i data-sn-text="L"></i><b data-sn-text="L + '!'"></b>
      <button data-sn-on-click="s = 'ok'"></button></main>`, { helpers: { risky }, strict: false });
    expect(n).toBe(2);
    expect(r.warnings().filter((w) => w.code == 6).length).toBe(2);
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(n).toBe(3);
    expect(r.root.querySelector('i')!.textContent + r.root.querySelector('b')!.textContent).toBe('OKOK!');
  });

  test('a let in a branch that is shown again, and in a dialog that opens later, is current', async () => {
    const up = (s: string) => s.toUpperCase();
    const r = await render(`<main data-sn-state="{ s: 'a', on: true }" data-sn-let="{ U: up(s) }"><template data-sn-if="on"><i data-sn-text="U"></i></template>
      <button id="t" data-sn-on-click="on = !on"></button><button id="s" data-sn-on-click="s = s + 'b'"></button><b data-sn-text="U"></b></main>`, { helpers: { up } });
    const click = async (id: string) => { r.root.querySelector<HTMLElement>(id)!.click(); await r.flush(); };
    await click('#t');
    await click('#s');
    await click('#t');
    expect(r.root.querySelector('i')!.textContent).toBe('AB');
    expect(r.root.querySelector('b')!.textContent).toBe('AB');
  });
});

describe('first paint and takeover', () => {
  const page = (let_: string) => `<!doctype html><html><head><script type="application/json" data-sn-resource="post">${JSON.stringify({ body: 'a b c', tags: ['x'] })}</script></head><body>
    <sn-resource name="post" src="/api/post"></sn-resource>
    <main data-sn-state="{ rev: 0 }" data-sn-let="{ doc: ${let_} }"><button data-sn-on-click="rev++"></button><ul><template data-sn-for="x in doc.words"><li data-sn-text="x.w"></li></template></ul><p data-sn-text="doc.words.length"></p></main></body></html>`;

  test('the early script renders a let over a helper', async () => {
    const { parse } = counting();
    await firstPaint(page("parse(post ? post.body : '')"), { helpers: { parse } });
    expect([...document.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['a', 'b', 'c']);
    expect(document.querySelector('p')!.textContent).toBe('3');
  });

  test('early, then a handler after the takeover that changes its input and reads it sees the new value', async () => {
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const html = `<!doctype html><html><head></head><body><main data-sn-state="{ xs: [1, 2], seen: 0 }" data-sn-let="{ total: sum(xs) }">
      <p data-sn-text="total"></p><i data-sn-text="total + 1"></i><b data-sn-text="seen"></b><button data-sn-on-click="xs.push(10); seen = total"></button></main></body></html>`;
    await firstPaint(html, { helpers: { sum } });
    expect(document.querySelector('p')!.textContent).toBe('3');
    expect(document.querySelector('i')!.textContent).toBe('4');
    const r = await render(html, { helpers: { sum }, firstPaint: {} });
    document.querySelector('button')!.click();
    await r.flush();
    expect(document.querySelector('b')!.textContent).toBe('13');
    expect(document.querySelector('p')!.textContent).toBe('13');
  });

  for (const [what, expr] of [
    ['primitive arguments', "parse(post ? post.body : '', { rev })"],
    // new objects at every call: adopted rows matched by position
    ['an object argument, new objects at every call: rows adopted by position', "parse(post ? post.body : '', { rev }, post)"],
  ] as const) {
    test(`the takeover changes nothing (${what})`, async () => {
      const { parse } = counting();
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
        firstPaint: { afterEarly: () => { early = [...document.querySelectorAll('li')]; watch.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true }); } },
      });
      await r.settle();
      watch.disconnect();
      expect(early.length).toBe(3);
      expect(changes).toEqual([]);
      const now = [...document.querySelectorAll('li')];
      expect(now.every((x, i) => x === early[i])).toBe(true);
      document.querySelector('button')!.click();
      await r.flush();
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
    // (each read calls it: two bindings read the let)
    expect([...new Set(m.calls)]).toEqual(['a b', 'c d e']);
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
    const r = await render(`<main data-sn-state="{ src: 'a b c' }"><x-n data-sn-with="{ doc: crunch.parse(src) }"></x-n></main>`,
      { lazyHelpers: m.helpers, components: { 'x-n': '<template data-sn-props="{ doc?: any }"><p data-sn-text="doc ? doc.words.length : \'…\'"></p></template>' } });
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

describe('the locale, and results that are their arguments', () => {
  // an i18n library's messages as a namespace of the app's helpers, with the locale connected to it (docs/configuration.md)
  const setup = () => {
    let loc = 'en';
    configure({ locale: { get: () => loc, set: (l) => { loc = l; } } });
    const m = {
      inbox_title: () => (loc === 'de' ? 'Posteingang' : 'Inbox'),
      items_count: ({ count }: { count: number }) => (loc === 'de' ? `${count} Einträge` : `${count} items`),
    };
    return Object.assign({ m, upper: (s: string) => s.toUpperCase() }, { switchTo: (l: string) => { loc = l; } });
  };
  const PAGE = `<!doctype html><html><head></head><body><main data-sn-state="{ n: 3 }" data-sn-let="{ title: m.inbox_title(), count: m.items_count({ count: n }), T: upper(m.inbox_title()) }">
    <p data-sn-text="title + ' | ' + count + ' | ' + T"></p><button id="de" data-sn-on-click="$locale = 'de'"></button><button id="n" data-sn-on-click="n = n + 1"></button></main></body></html>`;

  test('a locale that changes between the early file and the takeover', async () => {
    const helpers = setup();
    try {
      const text = () => document.querySelector('p')!.textContent;
      const r = await render(PAGE, { helpers, firstPaint: { afterEarly: () => helpers.switchTo('de') } });
      await r.flush();
      document.querySelector<HTMLElement>('#n')!.click();
      await r.flush();
      expect(text()).toBe('Posteingang | 4 Einträge | POSTEINGANG');
    } finally { configure({ locale: null }); }
  });

  test('a let over a namespace helper that reads the locale itself: the new language', async () => {
    const helpers = setup();
    try {
      const r = await render(PAGE, { helpers });
      const text = () => r.root.querySelector('p')!.textContent;
      expect(text()).toBe('Inbox | 3 items | INBOX');
      r.root.querySelector<HTMLElement>('#de')!.click();
      await r.flush();
      expect(text()).toBe('Posteingang | 3 Einträge | POSTEINGANG');
      r.root.querySelector<HTMLElement>('#n')!.click();
      await r.flush();
      expect(text()).toBe('Posteingang | 4 Einträge | POSTEINGANG');
    } finally { configure({ locale: null }); }
  });

  test('the same, early and after the takeover', async () => {
    const helpers = setup();
    try {
      const text = () => document.querySelector('p')!.textContent;
      let early = '';
      const r = await render(PAGE, { helpers, firstPaint: { afterEarly: () => { early = text()!; } } });
      expect(early).toBe('Inbox | 3 items | INBOX');
      expect(text()).toBe('Inbox | 3 items | INBOX');
      document.querySelector<HTMLElement>('#de')!.click();
      await r.flush();
      expect(text()).toBe('Posteingang | 3 Einträge | POSTEINGANG');
      document.querySelector<HTMLElement>('#n')!.click();
      await r.flush();
      expect(text()).toBe('Posteingang | 4 Einträge | POSTEINGANG');
    } finally { configure({ locale: null }); }
  });

  test('the built-in messages in a let: in the page\'s language, as a build compiles it', async () => {
    const page = '<main data-sn-let="{ K: fmt.plain(1) + m.hi() }"><p data-sn-text="K"></p></main>';
    const o = { helpers: { fmt: { plain: (n: number) => n + 1 } }, messages: { en: { hi: 'Hello' }, de: { hi: 'Hallo' } } };
    expect((await render(page, o)).root.querySelector('p')!.textContent).toBe('2Hello');
    expect((await render(page, { ...o, locale: 'de' })).root.querySelector('p')!.textContent).toBe('2Hallo');
  });

  test('a result that is its argument, or holds it, is the new object after an equal copy', async () => {
    const same = (o: { n: number }) => o;
    const wrap = (o: { n: number }) => ({ o });
    const r = await render(`<main data-sn-state="{ o: { n: 1 }, r: null, w: null }" data-sn-let="{ F: same(o), W: wrap(o) }"><p data-sn-text="F.n"></p><i data-sn-text="W.o.n"></i>
      <button data-sn-on-click="o = { n: 1 }; r = F === o; w = W.o === o"></button><b data-sn-text="r + ' ' + w"></b></main>`, { helpers: { same, wrap } });
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(r.root.querySelector('b')!.textContent).toBe('true true');
  });

  test('an object literal argument, a new one at each evaluation', async () => {
    const words = (s: string, o: { upper: boolean }) => s.split(' ').map((w) => (o.upper ? w.toUpperCase() : w));
    const r = await render(`<main data-sn-state="{ s: 'a b', upper: false, k: 0 }" data-sn-let="{ ws: words(s, { upper }) }"><p data-sn-text="ws.join() + k"></p>
      <button data-sn-on-click="k = k + 1; upper = false"></button></main>`, { helpers: { words } });
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(r.root.querySelector('p')!.textContent).toBe('a,b1');
  });
});

describe('memo(): the app\'s way to keep an expensive helper\'s result', () => {
  test('a memoized helper in a let: parsed once for each body, early and after the takeover; its result frozen and shared', async () => {
    const calls: string[] = [];
    const parse = memo((s: string) => { calls.push(s); return { words: s.split(' ').map((w) => ({ w })) }; });
    const html = `<!doctype html><html><head></head><body><main data-sn-state="{ src: 'a b', n: 0, frozen: null }" data-sn-let="{ doc: parse(src) }">
      <p data-sn-text="doc.words.length"></p><ul><template data-sn-for="x in doc.words"><li data-sn-text="x.w"></li></template></ul>
      <button id="n" data-sn-on-click="n++; frozen = Object.isFrozen(doc.words)"></button><button id="s" data-sn-on-click="src = 'c d e'"></button><b data-sn-text="n + ' ' + frozen"></b></main></body></html>`;
    let early = '';
    const r = await render(html, { helpers: { parse }, firstPaint: { afterEarly: () => { early = document.querySelector('p')!.textContent!; } } });
    expect(early).toBe('2');
    document.querySelector<HTMLElement>('#n')!.click();
    await r.flush();
    expect(document.querySelector('b')!.textContent).toBe('1 true');
    document.querySelector<HTMLElement>('#s')!.click();
    await r.flush();
    expect([...document.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['c', 'd', 'e']);
    expect(calls).toEqual(['a b', 'c d e']);
  });
});

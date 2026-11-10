// Components with a script: sinter creates the script's object per instance on its root,
// with live props, its state, refs and emit(), and runs connected / propsChanged / disconnected.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';
import { Component } from '../../src/components.js';

const RING = `<template data-sn-component="{ done: number; open: number }" data-sn-emits="{ pick: string }">
  <figure data-sn-state="{ clicks: 0 }">
    <canvas data-sn-ref="canvas" data-sn-attr="{ 'aria-label': done + ' of ' + (done + open) }"></canvas>
    <figcaption data-sn-text="done + ' / ' + (done + open) + ' (' + clicks + ')'"></figcaption>
    <template data-sn-if="open > 2"><b data-sn-ref="many">many</b></template>
  </figure>
</template>`;

test('per instance: connected with refs set, propsChanged once per render, state writes render, emit, disconnected', async () => {
  const log: string[] = [];
  class TaskRing extends Component<{ done: number; open: number }, { pick: string }, { canvas: HTMLCanvasElement; many?: HTMLElement }, { clicks: number }> {
    connected() {
      log.push(`connected ${this.props.done}/${this.props.open} ${this.refs.canvas.tagName} ${this.refs.many ? 'many' : '-'} ${this.root.tagName}`);
      this.refs.canvas.addEventListener('click', () => { this.state.clicks++; this.emit('pick', 'done'); });
    }
    propsChanged() { log.push(`props ${this.props.done}/${this.props.open} ${this.refs.many ? 'many' : '-'}`); }
    disconnected() { log.push(`gone ${this.props.done}`); }
  }
  const { root, flush, app } = await render(`
    <div data-sn-state="{ items: [{ id: 1, done: 1, open: 1 }, { id: 2, done: 5, open: 0 }], picked: '' }">
      <template data-sn-for="t in items" data-sn-key="t.id">
        <task-ring data-sn-prop="{ done: t.done, open: t.open }" data-sn-on-pick="picked = picked + t.id"></task-ring>
      </template>
      <p data-sn-text="picked"></p>
    </div>`, { components: { 'task-ring': RING }, scripts: { 'task-ring': { TaskRing } } });
  expect(log).toEqual(['connected 1/1 CANVAS - FIGURE', 'connected 5/0 CANVAS - FIGURE']);
  expect(root.querySelector('figcaption')!.textContent).toBe('1 / 2 (0)');
  log.length = 0;
  // a live prop: one propsChanged for the instance whose props changed, after the render (the ref inside the branch is set)
  app.state(root.querySelector('div')!).update((s) => { s.items[0].open = 3; s.items[0].done = 2; });
  await flush();
  expect(log).toEqual(['props 2/3 many']);
  // the script writes state; its event reaches the caller's handler
  (root.querySelector('canvas') as HTMLCanvasElement).dispatchEvent(new Event('click'));
  await flush();
  expect(root.querySelector('figcaption')!.textContent).toBe('2 / 5 (1)');
  expect(root.querySelector('p')!.textContent).toBe('1');
  log.length = 0;
  // its row is removed: disconnected
  app.state(root.querySelector('div')!).update((s) => { s.items.splice(1, 1); });
  await flush();
  expect(log).toEqual(['gone 5']);
});

test('a default export works; the refs of a nested component and of slot content are not the outer one\'s', async () => {
  const seen: string[] = [];
  class Outer extends Component { connected() { seen.push(`outer ${String(!!this.refs.own)} ${String(!!this.refs.inner)} ${String(!!this.refs.slotted)}`); } }
  await render(`<x-page></x-page>`, {
    components: {
      'x-page': '<template data-sn-component=""><main><x-outer><span data-sn-ref="slotted"></span></x-outer></main></template>',
      'x-outer': '<template data-sn-component=""><div><i data-sn-ref="own"></i><x-inner></x-inner><slot></slot></div></template>',
      'x-inner': '<template data-sn-component=""><p><b data-sn-ref="inner"></b></p></template>',
    },
    scripts: { 'x-outer': { default: Outer } },
  });
  expect(seen).toEqual(['outer true false false']);
  // a ref outside any component's markup
  await expect(render('<p data-sn-ref="x"></p>')).rejects.toThrow(/SN102 wrong-element: `data-sn-ref` names an element of a component's markup/);
}, 10_000);

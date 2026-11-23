// render() and component scripts: `scripts` gives each script's class, for a script in a file beside the
// component and for a single-file component's `<script>` alike; without one, a clear error, and a page that
// fails to mount does not stop the next render.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';
import { Component } from '../../src/components.js';

const TEMPLATE = `<template data-sn-props="{ done: number; open: number }">
  <figure><figcaption data-sn-text="done + ' / ' + (done + open)"></figcaption></figure>
</template>`;
// a single-file component: the `<script>` is its script (the test runs the class `scripts` gives, not this code)
const SFC = `${TEMPLATE}
<script lang="ts">
import { TaskRingComponent } from './task-ring.html';
export class TaskRing extends TaskRingComponent { connected() { throw new Error('the block does not run in render()'); } }
</script>`;
const PAGE = '<task-ring data-sn-with="{ done: 2, open: 1 }"></task-ring>';

test('a single-file component renders, its script the class `scripts` gives (the class, or the module)', async () => {
  const log: string[] = [];
  class TaskRing extends Component<{ done: number; open: number }> {
    connected() { log.push(`connected ${this.props.done}/${this.props.open} ${this.root.tagName}`); }
  }
  const { root } = await render(PAGE, { components: { 'task-ring': SFC }, scripts: { 'task-ring': TaskRing } });
  expect(root.querySelector('figcaption')!.textContent).toBe('2 / 3');
  expect(log).toEqual(['connected 2/1 FIGURE']);
  // a module: its export by the component's name, as the block exports it
  log.length = 0;
  await render(PAGE, { components: { 'task-ring': SFC }, scripts: { 'task-ring': { helper: () => 1, TaskRing } } });
  expect(log).toEqual(['connected 2/1 FIGURE']);
});

test('a single-file component in a folder of its own (`files`)', async () => {
  const log: string[] = [];
  class TaskRing extends Component<{ done: number; open: number }> {
    connected() { log.push(`connected ${this.props.done}/${this.props.open}`); }
  }
  const { root } = await render(PAGE, { files: { 'src/components/task-ring/task-ring.html': SFC }, scripts: { 'task-ring': { TaskRing } } });
  expect(root.querySelector('figcaption')!.textContent).toBe('2 / 3');
  expect(log).toEqual(['connected 2/1']);
});

test('a single-file component without `scripts`: an error naming the component and the option', async () => {
  const err = await render(PAGE, { components: { 'task-ring': SFC } }).then(() => null, (e: Error) => e);
  expect(err?.message).toMatch(/^sinter: <task-ring> has a script \(the `<script>` in its HTML, `\/src\/components\/task-ring\.html\.script\.ts`\) and render\(\)'s `scripts` option gives no class for it: pass `scripts: \{ 'task-ring': TaskRing \}`/);
  expect(err?.message).not.toMatch(/reading 'l'/);
});

test('a script in a file beside the component, without `scripts`: the same error, naming the file', async () => {
  const err = await render(PAGE, {
    files: { 'src/components/task-ring.html': TEMPLATE, 'src/components/task-ring.ts': 'export class TaskRing {}' },
  }).then(() => null, (e: Error) => e);
  expect(err?.message).toMatch(/^sinter: <task-ring> has a script \(`\/src\/components\/task-ring\.ts`\) and render\(\)'s `scripts` option gives no class for it: pass `scripts: \{ 'task-ring': TaskRing \}`, the class or the module \(`await import\('\.\.\/src\/components\/task-ring\.ts'\)`\)/);
  // a module without a class in it
  const other = await render(PAGE, { components: { 'task-ring': SFC }, scripts: { 'task-ring': { notAClass: 1 } } }).then(() => null, (e: Error) => e);
  expect(other?.message).toMatch(/^sinter: <task-ring> has a script .* and render\(\)'s `scripts` option gives no class in what it gives for it/);
});

test('a render after one whose page failed to mount', async () => {
  class TaskRing extends Component { constructor() { super(); throw new Error('broken constructor'); } }
  await expect(render(PAGE, { components: { 'task-ring': SFC }, scripts: { 'task-ring': TaskRing } })).rejects.toThrow('broken constructor');
  // and after the clear error, which is before mounting
  await expect(render(PAGE, { components: { 'task-ring': SFC } })).rejects.toThrow(/has a script/);
  const { root } = await render('<p data-sn-state="{ n: 1 }"><b data-sn-text="n"></b></p>');
  expect(root.querySelector('b')!.textContent).toBe('1');
  const again = await render(PAGE, { components: { 'task-ring': TEMPLATE } });
  expect(again.root.querySelector('figcaption')!.textContent).toBe('2 / 3');
});

// Components with a script: sinter creates the script's object per instance on its root,
// with live props, its state, refs and emit(), and runs connected / propsChanged / disconnected.
import { expect, test, vi } from 'vitest';
import { render } from '../../src/testing/index.js';
import { Component } from '../../src/components.js';

const RING = `<template data-sn-props="{ done: number; open: number }" data-sn-emits="{ pick: string }">
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
  const { root, flush, state } = await render(`
    <div data-sn-state="{ items: [{ id: 1, done: 1, open: 1 }, { id: 2, done: 5, open: 0 }], picked: '' }">
      <template data-sn-for="t in items" data-sn-key="t.id">
        <task-ring data-sn-with="{ done: t.done, open: t.open }" data-sn-on-pick="picked = picked + t.id"></task-ring>
      </template>
      <p data-sn-text="picked"></p>
      <button data-sn-on-click="items = []">clear</button>
    </div>`, { components: { 'task-ring': RING }, scripts: { 'task-ring': { TaskRing } } });
  expect(log).toEqual(['connected 1/1 CANVAS - FIGURE', 'connected 5/0 CANVAS - FIGURE']);
  expect(root.querySelector('figcaption')!.textContent).toBe('1 / 2 (0)');
  log.length = 0;
  // (the page writes the list, so the build leaves it live: the test's writes stand for the page's)
  // a live prop: one propsChanged for the instance whose props changed, after the render (the ref inside the branch is set)
  state(root.querySelector('div')!).update((s) => { s.items[0].open = 3; s.items[0].done = 2; });
  await flush();
  expect(log).toEqual(['props 2/3 many']);
  // the script writes state; its event reaches the caller's handler
  (root.querySelector('canvas') as HTMLCanvasElement).dispatchEvent(new Event('click'));
  await flush();
  expect(root.querySelector('figcaption')!.textContent).toBe('2 / 5 (1)');
  expect(root.querySelector('p')!.textContent).toBe('1');
  log.length = 0;
  // its row is removed: disconnected
  state(root.querySelector('div')!).update((s) => { s.items.splice(1, 1); });
  await flush();
  expect(log).toEqual(['gone 5']);
});

test('a default export works; the refs of a nested component and of slot content are not the outer one\'s', async () => {
  const seen: string[] = [];
  class Outer extends Component { connected() { seen.push(`outer ${String(!!this.refs.own)} ${String(!!this.refs.inner)} ${String(!!this.refs.slotted)}`); } }
  await render(`<x-page></x-page>`, {
    components: {
      'x-page': '<template data-sn-props=""><main><x-outer><span data-sn-ref="slotted"></span></x-outer></main></template>',
      'x-outer': '<template data-sn-props=""><div><i data-sn-ref="own"></i><x-inner></x-inner><slot></slot></div></template>',
      'x-inner': '<template data-sn-props=""><p><b data-sn-ref="inner"></b></p></template>',
    },
    scripts: { 'x-outer': { default: Outer } },
  });
  expect(seen).toEqual(['outer true false false']);
  // a ref outside any component's markup
  await expect(render('<p data-sn-ref="x"></p>')).rejects.toThrow(/SN102 wrong-element: `data-sn-ref` names an element of a component's markup/);
}, 10_000);

test('a script without the class named after the component, or a default export, fails the build', async () => {
  const { compile } = await import('../../src/compiler/index.js');
  const files: Record<string, string> = {
    '/p/src/components/task-ring.html': '<template data-sn-props=""><figure></figure></template>',
    '/p/src/components/task-ring.ts': 'export class Ring {}',
  };
  const d = compile('<task-ring></task-ring>', { file: '/p/i.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (f) => { if (f in files) return files[f]!; throw new Error('missing'); } }).diagnostics;
  expect(d.map((x) => `${x.code} ${x.message}`)).toEqual([expect.stringMatching(/^SN312 the script of `<task-ring>` \(`\/src\/components\/task-ring.ts`\) exports no class `TaskRing` and no default export/)]);
  files['/p/src/components/task-ring.ts'] = 'export class TaskRing {}';
  const ok = compile('<task-ring></task-ring>', { file: '/p/i.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (f) => { if (f in files) return files[f]!; throw new Error('missing'); } });
  expect(ok.diagnostics).toEqual([]);
  expect(ok.module).toContain("import { TaskRing as $cm$task_ring } from \"/src/components/task-ring.ts\";");
});

test('a script that throws in production: the error reaches the console, the rest of the page renders', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    class XBad extends Component { connected() { throw new Error('broken renderer'); } }
    const { root } = await render('<div><x-bad></x-bad><p>after</p></div>', {
      components: { 'x-bad': '<template data-sn-props="{}"><section></section></template>' }, scripts: { 'x-bad': { XBad } }, dev: false, strict: false,
    });
    expect(error.mock.calls.some((c: unknown[]) => c.some((x) => x instanceof Error && x.message === 'broken renderer'))).toBe(true);
    expect(root.querySelector('p')!.textContent).toBe('after');
  } finally { error.mockRestore(); }
});

test('a component in a folder of its own (`files`): its script runs as one beside a flat file does', async () => {
  const log: string[] = [];
  class TaskRing extends Component<{ done: number; open: number }> {
    connected() { log.push(`connected ${this.props.done}/${this.props.open}`); }
  }
  const { root } = await render('<task-ring data-sn-with="{ done: 2, open: 1 }"></task-ring>', {
    files: { 'src/components/task-ring/task-ring.html': RING }, scripts: { 'task-ring': { TaskRing } },
  });
  expect(root.querySelector('figcaption')!.textContent).toBe('2 / 3 (0)');
  expect(log).toEqual(['connected 2/1']);
});

test('refs inside a closed dialog, the dialog itself included, are set at mount; its other bindings and components wait', async () => {
  // sinter-alloy's palette (S14): its script reaches its dialog and field through refs, before the dialog opens
  const log: string[] = [];
  class XPalette extends Component<{ label: string }, Record<string, never>, { dialog: HTMLDialogElement; field: HTMLInputElement }> {
    connected() { log.push(`connected ${this.refs.dialog?.tagName} ${String(this.refs.dialog?.open)} ${this.refs.field?.tagName}`); }
  }
  class XHint extends Component { connected() { log.push('hint'); } }
  const PALETTE = `<template data-sn-props="{ label: string }">
    <section data-sn-state="{ q: '' }">
      <dialog data-sn-ref="dialog">
        <h2 data-sn-text="label + ':' + q"></h2>
        <input data-sn-ref="field" data-sn-model="q">
        <x-hint></x-hint>
      </dialog>
    </section>
  </template>`;
  const { root, flush } = await render(`
    <div data-sn-state="{ rows: [1] }">
      <x-palette data-sn-with="{ label: 'Go to' }"></x-palette>
      <template data-sn-for="r in rows" data-sn-key="r"><x-palette data-sn-with="{ label: 'Row ' + r }"></x-palette></template>
    </div>`, {
    components: { 'x-palette': PALETTE, 'x-hint': '<template data-sn-props="{}"><i></i></template>' },
    scripts: { 'x-palette': { XPalette }, 'x-hint': { XHint } },
  });
  // both refs are set in connected(), on the page and in a row; the component inside the dialogs has not started
  expect(log).toEqual(['connected DIALOG false INPUT', 'connected DIALOG false INPUT']);
  const [dialog, rowDialog] = [...root.querySelectorAll('dialog')], [h2, rowH2] = [...root.querySelectorAll('h2')];
  // the row's dialog was cloned: its text waits for it to open
  expect(rowH2!.textContent).toBe('');
  log.length = 0;
  // a change while the dialog is closed waits too
  const field = dialog!.querySelector('input')!;
  field.value = 'x';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect(h2!.textContent).not.toBe('Go to:x');
  expect(log).toEqual([]);
  dialog!.showModal();
  dialog!.dispatchEvent(new Event('toggle'));
  await flush();
  expect(h2!.textContent).toBe('Go to:x');
  expect(rowDialog!.open).toBe(false);
});

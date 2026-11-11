// @vitest-environment jsdom
// Custom elements in a real-browser-like DOM: jsdom, unlike happy-dom, does not upgrade elements
// cloned from a <template>'s content until they are connected.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

test('islands defined before mount: props in a row template reach the setters of the not-yet-upgraded clone', async () => {
  // Caley: <mail-frame> in a for-row got its props while the clone was not upgraded yet (not connected)
  const seen: unknown[] = [];
  class RowFrame extends HTMLElement {
    #m: unknown = null;
    get message() { return this.#m; }
    set message(v) { this.#m = v; seen.push(v); }
  }
  if (!customElements.get('row-frame')) customElements.define('row-frame', RowFrame);
  const { root, flush, state } = await render(`
    <div data-sn-state="{ ids: [1, 2], on: true }">
      <template data-sn-for="i in ids" data-sn-key="i"><row-frame data-sn-prop="{message: {id: i}}"></row-frame></template>
      <template data-sn-if="on"><row-frame data-sn-prop="{message: {id: 9}}"></row-frame></template>
      <button data-sn-on-click="ids = []">clear</button>
    </div>`);
  await flush();
  const els = [...root.querySelectorAll('row-frame')] as any[];
  expect(els.map((el) => el instanceof RowFrame)).toEqual([true, true, true]);
  expect(els.map((el) => Object.hasOwn(el, 'message'))).toEqual([false, false, false]);
  expect(els.map((el) => el.message)).toEqual([{ id: 1 }, { id: 2 }, { id: 9 }]);
  expect(seen).toEqual(expect.arrayContaining([{ id: 1 }, { id: 2 }, { id: 9 }]));
  // a new row later (the page writes the list: the test's write stands for the page's), and an upgraded element written again: straight through the setter
  state(els[0]).update((s) => { s.ids = [1, 2, 3]; });
  await flush();
  const added = root.querySelectorAll('row-frame')[2] as any;
  expect(Object.hasOwn(added, 'message')).toBe(false);
  expect(added.message).toEqual({ id: 3 });
  expect(seen).toContainEqual({ id: 3 });
});

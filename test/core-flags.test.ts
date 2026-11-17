// The suite's switchable core (test/core-flags.ts): a mounted page turns on its parts, and the core reads them.
import { expect, test } from 'vitest';
import { render } from '@tiaforge-ui/sinter/testing';
import * as flags from './core-flags.js';

const page = `<div data-sn-state="{ xs: ['a', 'b'] }">
  <button id="add" data-sn-on-click="xs = [...xs, 'c']">add</button>
  <ul id="l"><template data-sn-for="x in xs"><li data-sn-text="x"></li></template></ul>
</div>`;

test('each test starts with every part off; a page turns on the parts it uses', async () => {
  expect(flags.LIST).toBe(false);
  expect(flags.EVENTS).toBe(false);
  const { root, flush } = await render(page);
  expect([flags.LIST, flags.EVENTS, flags.RESOURCE, flags.DIALOG]).toEqual([true, true, false, false]);
  expect(root.querySelector('#l')!.textContent).toBe('ab');
  (root.querySelector('#add') as HTMLElement).click();
  await flush();
  expect(root.querySelector('#l')!.textContent).toBe('abc');
});

test('the core reads them: with lists off, a list is not rendered again', async () => {
  const { root, flush } = await render(page);
  flags.reset();
  flags.use({ v: 2, roots: [], templates: [], actions: [], resources: [], ev: ['click'] } as never);
  (root.querySelector('#add') as HTMLElement).click();
  await flush();
  expect(root.querySelector('#l')!.textContent).toBe('ab');
});

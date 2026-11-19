// @vitest-environment jsdom
// A component's tag as a fill of a slot that passes data: its `data-sn-with` is compiled in the fill's scope,
// so it reads `$slot` (as an element fill does).
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const components = {
  'x-list': '<template data-sn-props="{ xs: any[]; item: Slot<{ x: any }> }"><ul><template data-sn-for="x in xs"><li><slot name="item" data-sn-with="{ x }"><span data-sn-text="x.t"></span></slot></li></template></ul></template>',
  'x-pill': '<template data-sn-props="{ t: string }"><b class="pill" data-sn-text="t"></b></template>',
};

test('a component tag fills the slot and reads $slot in its props', async () => {
  const { root, settle } = await render(`<div data-sn-state="{ xs: [{ t: 'a' }, { t: 'b' }] }"><button id="w" data-sn-on-click="xs = [{ t: 'c' }]">w</button>
    <x-list data-sn-with="{ xs }"><x-pill slot="item" data-sn-with="{ t: $slot.x.t }"></x-pill></x-list></div>`, { components });
  expect([...root.querySelectorAll('li > b.pill')].map((b) => b.textContent)).toEqual(['a', 'b']);
  (root.querySelector('#w') as HTMLButtonElement).click();
  await settle();
  expect([...root.querySelectorAll('li > b.pill')].map((b) => b.textContent)).toEqual(['c']);
});

test('over constants too', async () => {
  const { root } = await render(`<div data-sn-state="{ xs: [{ t: 'a' }] }"><x-list data-sn-with="{ xs }"><x-pill slot="item" data-sn-with="{ t: $slot.x.t + '!' }"></x-pill></x-list></div>`, { components });
  expect(root.querySelector('li > b.pill')!.textContent).toBe('a!');
});

test('a fill tag whose component\'s root is an if/else chain, and the tag\'s own attributes reading $slot', async () => {
  const more = { ...components, 'x-mark': '<template data-sn-props="{ t: string }"><template data-sn-if="t === \'a\'"><b data-sn-text="t"></b></template><template data-sn-else><i data-sn-text="t"></i></template></template>' };
  const { root, settle } = await render(`<div data-sn-state="{ xs: [{ t: 'a' }, { t: 'b' }] }"><button id="w" data-sn-on-click="xs = [{ t: 'b' }]">w</button>
    <x-list data-sn-with="{ xs }"><x-mark slot="item" data-sn-with="{ t: $slot.x.t }" data-sn-class="{ on: $slot.x.t === 'a' }"></x-mark></x-list></div>`, { components: more });
  expect([...root.querySelectorAll('li > b, li > i')].map((e) => `${e.localName}.${e.className}:${e.textContent}`)).toEqual(['b.on:a', 'i.:b']);
  (root.querySelector('#w') as HTMLButtonElement).click();
  await settle();
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['b']);
});

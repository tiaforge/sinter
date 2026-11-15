// @vitest-environment jsdom
// `<sn-component use>` choosing a component whose root is an if/else chain: the chain's condition reads the
// candidate's props, not the caller's names.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const components = {
  'x-ifelse': '<template data-sn-component="{ href?: string; label: string }"><template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template><template data-sn-else><button data-sn-text="label"></button></template></template>',
  'x-plain': '<template data-sn-component="{ href?: string; label: string }"><span data-sn-text="label"></span></template>',
};
const list = (writes: boolean) => `<div data-sn-state="{ xs: [{ k: 'a', href: '/a', t: 'a' }, { k: 'a', t: 'b' }, { k: 'v', t: 'c' }] }">${writes ? `<button id="w" data-sn-on-click="xs = [{ k: 'a', t: 'd' }, { k: 'a', href: '/e', t: 'e' }]">w</button>` : ''}
  <p><template data-sn-for="x in xs"><sn-component use="{ a: 'x-ifelse', v: 'x-plain' }[x.k]" data-sn-prop="{ href: x.href, label: x.t }"></sn-component></template></p></div>`;
const shape = (p: Element) => [...p.children].map((e) => `${e.localName}${e.getAttribute('href') ? `[${e.getAttribute('href')}]` : ''}:${e.textContent}`);

test('over state, then a change', async () => {
  const { root, settle } = await render(list(true), { components });
  expect(shape(root.querySelector('p')!)).toEqual(['a[/a]:a', 'button:b', 'span:c']);
  (root.querySelector('#w') as HTMLButtonElement).click();
  await settle();
  expect(shape(root.querySelector('p')!)).toEqual(['button:d', 'a[/e]:e']);
});

test('over constants', async () => {
  const { root } = await render(list(false), { components });
  expect(shape(root.querySelector('p')!)).toEqual(['a[/a]:a', 'button:b', 'span:c']);
});

test('a component used inside itself: a data-sn-if on an optional prop is decided per instance, not at build time', async () => {
  const tree = { 'x-node': '<template data-sn-component="{ n: any; href?: string }"><span><template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="n.t"></a></template><template data-sn-else><i data-sn-text="n.t"></i></template><template data-sn-for="c in n.c"><x-node data-sn-prop="{ n: c, href: c.href }"></x-node></template></span></template>' };
  const { root } = await render(`<div data-sn-state="{ t: { t: 'r', c: [{ t: 'a', href: '/a', c: [] }, { t: 'b', c: [] }] } }"><button data-sn-on-click="t = null">w</button><x-node data-sn-prop="{ n: t }"></x-node></div>`, { components: tree });
  expect([...root.querySelectorAll('span span > :is(a, i)')].map((e) => `${e.localName}:${e.textContent}`)).toEqual(['a:a', 'i:b']);
});

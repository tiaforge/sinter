// Page-wide key filters: `data-sn-on-keydown-page-j` on an element runs in its scope for a `j` that nothing nearer
// the focus took, wherever the focus is (`<body>` after load, a nav rail beside it). Fields keep their keys, an
// `inert` subtree and the page behind a modal dialog hear nothing, and a nearer filter for the key wins. (Caley's
// mail page: j/k move through the list its own state holds, whether focus is in the list or not.)
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

function press(target: Element, key: string, init: KeyboardEventInit = {}): boolean {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

const PAGE = (nav = '', attrs = '') => `
  <nav>${nav}<button id="rail">Inbox</button><input id="search"></nav>
  <div class="mail" data-sn-state="{ at: 0, log: [] }" data-sn-on-keydown-page-j="emit('step', 1)" data-sn-on-keydown-page-shift-k="log.push('K')"
       data-sn-on-step="at = at + $event.detail; log.push('j' + at)" ${attrs}>
    <p data-sn-text="log.join(' ')"></p><button id="inside">x</button>
  </div>`;
const log = (root: ParentNode) => root.querySelector('p')!.textContent;

test('with focus on <body>, on a control beside the element or inside it: the filter runs in the element\'s scope', async () => {
  const { root, flush } = await render(PAGE());
  const body = (root as Element).ownerDocument!.body;
  expect(press(body, 'j')).toBe(true);
  expect(press(root.querySelector('#rail')!, 'j')).toBe(true);
  expect(press(root.querySelector('#inside')!, 'j')).toBe(true);
  press(body, 'K', { shiftKey: true });
  expect(press(body, 'k')).toBe(false);
  await flush();
  expect(log(root)).toBe('j1 j2 j3 K');
});

test('a field\'s keys are the field\'s; Enter and Space on a button are the button\'s', async () => {
  const { root, flush } = await render(PAGE().replace('page-j', 'page-enter'));
  expect(press(root.querySelector('#search')!, 'j')).toBe(false);
  expect(press(root.querySelector('#rail')!, 'Enter')).toBe(false);
  await flush();
  expect(log(root)).toBe('');
});

test('a nearer filter for the key wins: on the focused part, or on <body> for a key sent to it', async () => {
  const { root, flush } = await render(`<div data-sn-state="{ n: [] }"><span id="n" data-sn-text="n.join(' ')"></span>
    <section data-sn-on-keydown-j="n.push('section')"><button id="b">b</button></section></div>${PAGE()}`);
  press(root.querySelector('#b')!, 'j');
  press(root.querySelector('#rail')!, 'j');
  await flush();
  expect(root.querySelector('#n')!.textContent).toBe('section');
  expect(log(root)).toBe('j1');
});

test('not while the element is inert, nor once it has left the page; once again when it is back', async () => {
  const { root, flush, settle } = await render(`<div data-sn-state="{ on: true, inert: false }">
    <button id="toggle" data-sn-on-click="on = !on"></button><button id="freeze" data-sn-on-click="inert = !inert"></button>
    <template data-sn-if="on"><section data-sn-attr="{ inert }">${PAGE()}</section></template></div>`);
  const body = (root as Element).ownerDocument!.body;
  press(body, 'j');
  (root.querySelector('#freeze') as HTMLElement).click(); await settle();
  expect(press(body, 'j')).toBe(false);
  (root.querySelector('#freeze') as HTMLElement).click(); await settle();
  press(body, 'j');
  await flush();
  expect(log(root)).toBe('j1 j2');
  (root.querySelector('#toggle') as HTMLElement).click(); await settle();
  expect(press(body, 'j')).toBe(false);
  (root.querySelector('#toggle') as HTMLElement).click(); await settle();
  press(body, 'j');
  await flush();
  expect(log(root)).toBe('j1');
});

test('not behind a modal dialog: the page there is inert; inside one, the dialog\'s own filters', async () => {
  const { root, flush } = await render(`${PAGE()}<dialog id="d"><button id="in">x</button><div data-sn-state="{ n: 0 }" data-sn-on-keydown-page-j="n++"><i data-sn-text="n"></i></div></dialog>`);
  const d = root.querySelector('dialog')!;
  d.showModal();
  // (jsdom has no `:modal`; browsers do)
  if (!d.matches(':modal')) (d as { matches: (q: string) => boolean }).matches = (q) => q === ':modal' ? d.open : Element.prototype.matches.call(d, q);
  expect(press(root.querySelector('#in')!, 'j')).toBe(true);
  expect(press((root as Element).ownerDocument!.body, 'j')).toBe(true);
  await flush();
  expect(log(root)).toBe('');
  expect(root.querySelector('i')!.textContent).toBe('2');
  d.close();
  press((root as Element).ownerDocument!.body, 'j');
  await flush();
  expect(log(root)).toBe('j1');
});

const OPTS = { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('none'); } };
const errors = (body: string) => compile(`<!doctype html><html><head></head><body>${body}</body></html>`, OPTS).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

test('`page` comes first; not in a loop\'s rows', () => {
  expect(errors('<div data-sn-state="{ n: 0 }" data-sn-on-keydown-shift-page-n="n++"></div>')).toEqual([expect.stringMatching(/^SN101 `page` comes first.*data-sn-on-keydown-page-shift-n/)]);
  expect(errors('<div data-sn-state="{ xs: [1, 2], n: 0 }"><button data-sn-on-click="xs = [3]"></button><template data-sn-for="x in xs"><p data-sn-on-keydown-page-j="n = x"></p></template></div>'))
    .toEqual([expect.stringMatching(/^SN102 a page-wide key filter/)]);
  expect(errors('<div data-sn-state="{ n: 0 }" data-sn-on-keydown-page-mod-enter="n++" data-sn-on-keydown-pageup="n--"></div>')).toEqual([]);
});

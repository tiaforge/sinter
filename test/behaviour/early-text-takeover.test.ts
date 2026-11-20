// @vitest-environment jsdom
// The early script renders a row, branch or choice whose top node is a `<template data-sn-text>`: the text
// replaces its placeholder comment. When the page module does not adopt what the early script rendered (another
// number of rows, another branch), it clears it: the text too, not only the placeholder.
import { expect, test } from 'vitest';
import { mockRequests, render } from '../../src/testing/index.js';

const nodes = (el: Element) => [...el.childNodes].map((n) => (n.nodeType === 8 ? `<!--${(n as Comment).data}-->` : n.nodeType === 3 ? JSON.stringify((n as Text).data) : (n as Element).localName));
/** the embedded data, changed after the early script ran and before the page module reads it */
const swap = (data: unknown) => ({ firstPaint: { afterEarly: () => { document.querySelector('script[type="application/json"]')!.textContent = JSON.stringify(data); } } });
const page = (body: string, data: unknown) => `<!doctype html><html><head><script type="application/json" data-sn-data="all">${JSON.stringify(data)}</script></head><body>
  <sn-resource name="all" src="/api/all"></sn-resource><p>${body}</p></body></html>`;

test('a list of text rows: 3 rendered early, 1 by the page module', async () => {
  const three = { c: [{ name: 'Ada' }, { name: 'Grace' }, { name: 'Lin' }] };
  const { root, settle } = await render(page('<template data-sn-for="c in all.c"><template data-sn-text="c.name"></template></template>', three), swap({ c: [{ name: 'Ada' }] }));
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('Ada');
  expect(nodes(root.querySelector('p')!).filter((n) => n.startsWith('"'))).toEqual(['"Ada"']);
});

test('a branch whose top node is a text: rendered early, the other branch by the page module', async () => {
  const { root, settle } = await render(page('<template data-sn-if="all.on"><template data-sn-text="all.a"></template></template><template data-sn-else><b>off</b></template>', { on: true, a: 'yes' }), swap({ on: false, a: 'yes' }));
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('off');
});

test('a choice whose case is a text fill: rendered early, another candidate by the page module', async () => {
  const components = {
    'x-doc': '<template data-sn-props="{ doc: any; link: Slot<{ node: any }> }"><span><template data-sn-for="v in doc"><sn-component use="{ link: \'x-l\', bold: \'x-b\' }[v.k]" data-sn-with="{ node: v }"></sn-component></template></span></template>',
    'x-l': '<template data-sn-props="{ node: any }"><slot name="link" data-sn-with="{ node }"><a data-sn-text="node.s"></a></slot></template>',
    'x-b': '<template data-sn-props="{ node: any }"><b data-sn-text="node.s"></b></template>',
  };
  const { root, settle } = await render(page('<x-doc data-sn-with="{ doc: all.c }"><template slot="link" data-sn-text="$slot.node.s"></template></x-doc>', { c: [{ k: 'link', s: 'early' }] }),
    { ...swap({ c: [{ k: 'bold', s: 'late' }] }), components });
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('late');
  expect(root.querySelector('b')!.textContent).toBe('late');
});

test('adopted: the same rows, then a change the page module writes', async () => {
  const data = { c: [{ name: 'Ada' }, { name: 'Grace' }] };
  const { root, settle } = await render(page('<template data-sn-for="c in all.c"><template data-sn-text="c.name"></template>,</template><button id="r" data-sn-on-click="refresh(all)">r</button>', data),
    { firstPaint: true, requests: mockRequests({ 'GET /api/all': { c: [{ name: 'Bo' }, { name: 'Cy' }, { name: 'Di' }] } }) });
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('Ada,Grace,r');
  (root.querySelector('#r') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('Bo,Cy,Di,r');
});

test('adopted: rows that are only a text, then a change the page module writes', async () => {
  const data = { c: [{ name: 'Ada' }, { name: 'Grace' }] };
  const { root, settle } = await render(page('<template data-sn-for="c in all.c"><template data-sn-text="c.name"></template></template><button id="r" data-sn-on-click="refresh(all)">r</button>', data),
    { firstPaint: true, requests: mockRequests({ 'GET /api/all': { c: [{ name: 'Bo' }] } }) });
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('AdaGracer');
  (root.querySelector('#r') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('Bor');
  expect(root.querySelectorAll('button')).toHaveLength(1);
});

test('adopted keyed rows that are only a text: removing the first row removes its text', async () => {
  const data = { c: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Lin' }] };
  const { root, settle } = await render(page('<template data-sn-for="c in all.c" data-sn-key="c.id"><template data-sn-text="c.name"></template></template><button id="r" data-sn-on-click="refresh(all)">r</button>', data),
    { firstPaint: true, requests: mockRequests({ 'GET /api/all': { c: [{ id: 2, name: 'Grace' }, { id: 3, name: 'Lin' }] } }) });
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('AdaGraceLinr');
  (root.querySelector('#r') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('GraceLinr');
});

test('adopted rows that end with a text: removing the first row removes its text, not the next rows', async () => {
  const data = { c: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Lin' }] };
  const { root, settle } = await render(page('<template data-sn-for="c in all.c" data-sn-key="c.id"><i>-</i><template data-sn-text="c.name"></template></template><button id="r" data-sn-on-click="refresh(all)">r</button>', data),
    { firstPaint: true, requests: mockRequests({ 'GET /api/all': { c: [{ id: 2, name: 'Grace' }, { id: 3, name: 'Lin' }] } }) });
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('-Ada-Grace-Linr');
  (root.querySelector('#r') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('-Grace-Linr');
});

test('adopted rows that end with a text: removing a middle row, then the first', async () => {
  const data = { c: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Lin' }] };
  let next: unknown = { c: [{ id: 1, name: 'Ada' }, { id: 3, name: 'Lin' }] };
  const { root, settle } = await render(page('<template data-sn-for="c in all.c" data-sn-key="c.id"><i>-</i><template data-sn-text="c.name"></template></template><button id="r" data-sn-on-click="refresh(all)">r</button>', data),
    { firstPaint: true, requests: mockRequests({ 'GET /api/all': () => next }) });
  await settle();
  (root.querySelector('#r') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('-Ada-Linr');
  next = { c: [{ id: 3, name: 'Lin' }, { id: 1, name: 'Ada' }] };
  (root.querySelector('#r') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('-Lin-Adar');
});

test('the node lists the early script leaves for the page module are the nodes in the page: the texts, not the placeholders they replaced', async () => {
  const data = { c: [{ name: 'Ada' }, { name: 'Grace' }], on: true };
  const lists: Node[][] = [];
  await render(page('<template data-sn-for="c in all.c"><i>-</i><template data-sn-text="c.name"></template></template><template data-sn-if="all.on"><b>+</b><template data-sn-text="all.c[0].name"></template></template>', data), {
    firstPaint: { afterEarly: () => {
      for (const n of document.querySelector('p')!.childNodes) {
        const rows = (n as any)[Symbol.for('sinter.early.rows')], br = (n as any)[Symbol.for('sinter.early')];
        if (rows) lists.push(...rows.rows);
        if (br) lists.push(br.nodes);
      }
    } },
  });
  expect(lists.map((l) => l.map((n) => (n.nodeType === 3 ? (n as Text).data : n.nodeName)))).toEqual([['I', 'Ada'], ['I', 'Grace'], ['B', 'Ada']]);
  expect(lists.flat().every((n) => n.isConnected)).toBe(true);
});

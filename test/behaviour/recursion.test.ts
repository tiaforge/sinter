// A component used inside itself: one shared definition in the head, instantiated per item at any
// depth; nested items are changed along their path.
import { expect, test } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const THREAD = `<template data-sn-component="{ comment: { id: number; body: string; replies: any[] } }">
  <li>
    <p data-sn-text="comment.body" data-sn-on-click="patch(comment, { body: comment.body + '!' })"></p>
    <button data-sn-on-click="remove(comment)">x</button>
    <button class="reply" data-sn-on-click="upsert(comment.replies, { id: comment.id * 10, body: 're ' + comment.body, replies: [] })">+</button>
    <ul>
      <template data-sn-for="r in comment.replies" data-sn-key="r.id">
        <comment-thread data-sn-prop="{ comment: r }"></comment-thread>
      </template>
    </ul>
  </li>
</template>`;

const TREE = [
  { id: 1, body: 'a', replies: [{ id: 2, body: 'b', replies: [{ id: 3, body: 'c', replies: [{ id: 4, body: 'd', replies: [] }] }] }] },
  { id: 5, body: 'e', replies: [] },
];
const bodies = (root: HTMLElement) => [...root.querySelectorAll('p')].map((p) => p.textContent);

test('a tree renders at any depth from one definition in the head', async () => {
  const requests = mockRequests({ 'GET /api/c': TREE });
  const { root, settle } = await render(`<sn-resource name="comments" src="/api/c" key="id"></sn-resource>
    <ul><template data-sn-for="c in comments"><comment-thread data-sn-prop="{ comment: c }"></comment-thread></template></ul>`,
  { requests, components: { 'comment-thread': THREAD } });
  await settle();
  expect(bodies(root)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(document.head.querySelectorAll('template#sn-def-comment-thread')).toHaveLength(1);
  // the depth: d is four lists deep
  expect(root.querySelectorAll('ul ul ul ul p')[0]!.textContent).toBe('d');
});

test('patch, remove and upsert along the path, at any depth', async () => {
  const requests = mockRequests({ 'GET /api/c': TREE });
  const { root, settle, flush } = await render(`<sn-resource name="comments" src="/api/c" key="id"></sn-resource>
    <ul><template data-sn-for="c in comments"><comment-thread data-sn-prop="{ comment: c }"></comment-thread></template></ul>
    <output data-sn-text="comments[0].replies[0].replies[0].body"></output>`,
  { requests, components: { 'comment-thread': THREAD } });
  await settle();
  const p = (t: string) => [...root.querySelectorAll('p')].find((x) => x.textContent === t)!;
  p('c').click(); await flush();
  expect(bodies(root)).toEqual(['a', 'b', 'c!', 'd', 'e']);
  // the resource holds it: the row was replaced along the path
  expect(root.querySelector('output')!.textContent).toBe('c!');
  p('a').click(); await flush();
  expect(bodies(root)).toEqual(['a!', 'b', 'c!', 'd', 'e']);
  // remove a nested one, and its subtree goes
  (p('b').parentElement!.querySelector('button') as HTMLButtonElement).click(); await flush();
  expect(bodies(root)).toEqual(['a!', 'e']);
  // a reply to a reply
  (p('e').parentElement!.querySelector('.reply') as HTMLButtonElement).click(); await flush();
  expect(bodies(root)).toEqual(['a!', 'e', 're e']);
  (p('re e').parentElement!.querySelector('.reply') as HTMLButtonElement).click(); await flush();
  expect(bodies(root)).toEqual(['a!', 'e', 're e', 're re e']);
});

test('first paint: a tree over state renders before the page module', async () => {
  const { root } = await firstPaint(`<div data-sn-state="{ tree: { id: 1, body: 'top', replies: [{ id: 2, body: 'child', replies: [] }] } }">
    <ul><comment-thread data-sn-prop="{ comment: tree }"></comment-thread></ul></div>`, { components: { 'comment-thread': THREAD.replace(/ data-sn-on-click="[^"]*"/g, '') } });
  expect(root.querySelector('p')!.textContent).toBe('top');
});

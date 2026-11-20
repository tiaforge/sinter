// The three status lines of a list (docs/resources.md#loading-empty-and-error): "Loading…" while the
// first load runs, the empty message once a load has answered and none runs, the error. A reload of an
// empty list (`refresh()`, a `src` change) shows one of them, not both.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { mockRequests, render } from '../../src/testing/index.js';

const repo = resolve(import.meta.dirname, '../..');

test('the starter\'s "Loading…" and "No tasks here." never show together, also while an empty list reloads', async () => {
  const page = readFileSync(resolve(repo, 'packages/create/template/index.html'), 'utf8');
  // the starter's own two lines, over its resource, with a button that reloads it
  const lines = [/<p[^>]*>Loading…<\/p>/, /<p[^>]*>No tasks here\.<\/p>/].map((re) => re.exec(page)![0]);
  const requests = mockRequests({ 'GET /api/tasks': [] });
  const r = await render(`<main data-sn-let="{ shown: tasks }">
    <sn-resource name="tasks" src="/api/tasks" key="id"></sn-resource>
    ${lines.join('\n')}
    <button data-sn-on-click="refresh(tasks)">Reload</button></main>`, { requests });
  const shown = () => [...r.root.querySelectorAll('p')].filter((p) => !p.hidden).map((p) => p.textContent);
  await r.flush();
  expect(shown()).toEqual(['Loading…']);
  await r.settle();
  expect(shown()).toEqual(['No tasks here.']);
  r.root.querySelector('button')!.click();
  await r.flush();
  expect(requests.pending).toBe(1);
  expect(shown()).toEqual(['Loading…']);
  await r.settle();
  expect(shown()).toEqual(['No tasks here.']);
});

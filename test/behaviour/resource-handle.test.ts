// The store handle custom elements get (`instance(root).resource(name)`): its `src` and `order`.
import { describe, expect, test } from 'vitest';
import { mockRequests, render } from '../../src/testing/index.js';

describe('resource handle: src and order', () => {
  test('src is the URL it loads now: it follows the params, is null while `when` is false; order as written', async () => {
    const requests = mockRequests({ 'GET /api/boards/1/tasks': [], 'GET /api/boards/2/tasks': [] });
    const { app, root, settle } = await render(`
      <div data-sn-state="{ board: 1, on: true }">
        <sn-resource name="tasks" src="/api/boards/{board}/tasks?open=1" when="on" key="id" order="-rank"></sn-resource>
        <button id="next" data-sn-on-click="board = 2"></button>
        <button id="off" data-sn-on-click="on = false"></button>
        <i data-sn-text="tasks.length"></i>
      </div>`, { requests });
    await settle();
    const tasks = app.resource('tasks');
    expect([tasks.src, tasks.order]).toEqual(['/api/boards/1/tasks?open=1', '-rank']);
    root.querySelector<HTMLElement>('#next')!.click();
    await settle();
    expect(tasks.src).toBe('/api/boards/2/tasks?open=1');
    root.querySelector<HTMLElement>('#off')!.click();
    await settle();
    expect(tasks.src).toBeNull();
    expect(tasks.order).toBe('-rank');
  });

  test('with an API: its base included, as the request layer gets it; no pagination parameters', async () => {
    const requests = mockRequests({ 'GET /v1/tasks': [] });
    const { app, settle } = await render(
      '<sn-resource name="tasks" src="/tasks" key="id" order="rank" paginate="{ size: 20, numbered: true }"></sn-resource><i data-sn-text="tasks.length"></i>',
      { requests, apis: { main: { base: '/v1', operations: { 'GET /tasks': { query: ['page', 'limit'] } } } } } as never,
    );
    await settle();
    expect(requests.calls.map((c) => c.url)).toEqual(['/v1/tasks?page=1&limit=20']);
    expect([app.resource('tasks').src, app.resource('tasks').order]).toEqual(['/v1/tasks', 'rank']);
  });

  test('a POST resource: its URL without the body; null for call, for and file: resources; order null without one', async () => {
    const requests = mockRequests({ 'POST /api/search': [], 'GET /api/accounts': [{ id: 1 }], 'GET /api/boxes': [] });
    const { app, settle } = await render(`
      <sn-resource name="hits" src="/api/search" method="POST" body="{ q: 1 }" key="id"></sn-resource>
      <sn-resource name="got" call="go()"></sn-resource>
      <sn-resource name="accounts" src="/api/accounts" key="id"></sn-resource>
      <sn-resource name="boxes" for="a in accounts" src="/api/boxes?a={a.id}" key="id"></sn-resource>
      <sn-resource name="intro" src="file:/data/intro.json"></sn-resource>
      <i data-sn-text="[hits.length, got, boxes.length, intro.t]"></i>`,
      { requests, actions: { go: async () => 1 }, files: { 'data/intro.json': '{"t":"x"}' } });
    await settle();
    expect(['hits', 'got', 'boxes', 'intro'].map((n) => app.resource(n).src)).toEqual(['/api/search', null, null, null]);
    expect(app.resource('hits').order).toBeNull();
  });
});

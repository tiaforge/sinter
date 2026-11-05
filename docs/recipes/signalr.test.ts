import { afterEach, expect, test } from 'vitest';
import { configure } from '@tiaforge-ui/sinter';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import { signalRTransport } from './signalr-transport.js';
import page from './signalr.html?raw';

// A stand-in for HubConnection: the test calls invoke() where the server would call SendAsync().
function fakeHub() {
  const handlers = new Map<string, (payload: unknown) => void>();
  let onclose = () => {};
  return {
    started: false,
    on(name: string, fn: (payload: unknown) => void) { handlers.set(name, fn); },
    onclose(fn: () => void) { onclose = fn; },
    async start() { this.started = true; },
    async stop() { this.started = false; },
    invoke(name: string, payload: unknown) { handlers.get(name)?.(payload); },
    lose() { this.started = false; onclose(); },
  };
}

afterEach(() => configure({ transport: null }));

test('applies hub messages to the list', async () => {
  const hubs: Array<ReturnType<typeof fakeHub>> = [];
  configure({ transport: (url) => (url.startsWith('/hubs/') ? signalRTransport(() => { hubs.push(fakeHub()); return hubs.at(-1) as never; }) : undefined) });
  const requests = mockRequests({ 'GET /api/people': [{ id: 1, name: 'Bob' }] });
  const { root, flush, settle, advance } = await render(page, { requests });
  await settle();
  expect(hubs[0]!.started).toBe(true);

  hubs[0]!.invoke('person_updated', { person: { id: 2, name: 'Ada' } });
  hubs[0]!.invoke('person_removed', { id: 1 });
  await flush();
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Ada']);

  // a lost connection: sinter reconnects with a new hub and refetches what the stream feeds
  hubs[0]!.lose();
  await advance(2000); // the backoff (1 s ± jitter) before reconnecting
  await settle();
  expect(hubs).toHaveLength(2);
  expect(requests.calls.filter((c) => c.path === '/api/people')).toHaveLength(2);
});

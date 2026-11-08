// A resource only dialogs read is fetched with `priority: 'low'`; everything else with the default.
// happy-dom's and Node's Request drop `priority`, so the init passed to `new Request` is recorded.
import { afterEach, expect, test } from 'vitest';
import { render, mockRequests } from '../../src/testing/index.js';

const inits: Array<[string, RequestInit | undefined]> = [];
const Real = globalThis.Request;
class Recording extends Real { constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init); if (typeof input == 'string' || input instanceof URL) inits.push([String(input), init]); } }
afterEach(() => { globalThis.Request = Real; inits.length = 0; });

test('a resource read only inside a dialog is requested with low priority', async () => {
  globalThis.Request = Recording as typeof Request;
  const requests = mockRequests({ 'GET /api/user': { name: 'a' }, 'GET /api/tags': ['x'] });
  const { settle } = await render(`
    <sn-resource name="user" src="/api/user"></sn-resource>
    <sn-resource name="tags" src="/api/tags"></sn-resource>
    <p data-sn-text="user.name"></p>
    <dialog><p data-sn-text="tags.length"></p></dialog>`, { requests });
  await settle();
  const by = Object.fromEntries(inits.map(([u, i]) => [new URL(u).pathname, (i as { priority?: string })?.priority]));
  expect(by).toEqual({ '/api/user': undefined, '/api/tags': 'low' });
});

// The types of a view transition (docs/proposals/swap-navigation.md §8), the same for a swap and a page
// load, so one stylesheet rule (`:root:active-view-transition-type(sn-back)`) styles both: the navigation's
// kind, and a traversal's direction from the entries' indexes.
import { afterEach, expect, test } from 'vitest';
import { vtTypes } from '../../src/links.js';
import { render } from '../../src/testing/index.js';

test('the kind, and a traversal\'s direction', () => {
  expect(vtTypes('push')).toEqual(['sn-push']);
  expect(vtTypes('replace', 2, 2)).toEqual(['sn-replace']);
  expect(vtTypes('traverse', 3, 1)).toEqual(['sn-traverse', 'sn-back']);
  expect(vtTypes('traverse', 1, 3)).toEqual(['sn-traverse', 'sn-forward']);
  // an index the browser does not give: the kind alone
  expect(vtTypes('traverse', undefined, 1)).toEqual(['sn-traverse']);
});

const g = globalThis as { navigation?: unknown };
afterEach(() => { delete g.navigation; });

test('page loads: the types on the browser\'s transition, on the page left and on the next', async () => {
  // Back from entry 3 to entry 1
  g.navigation = Object.assign(new EventTarget(), {
    currentEntry: { key: 'k', index: 3 },
    activation: { navigationType: 'traverse', from: { index: 3 }, entry: { index: 1 } },
  });
  const r = await render('<a href="/x"><span data-sn-transition="\'a\'">a</span></a>', { url: 'http://localhost/' });
  await r.settle();
  const fire = async (type: 'pageswap' | 'pagereveal', activation?: object) => {
    const types = new Set<string>();
    await r.window(type, { viewTransition: { types, finished: Promise.resolve() }, activation });
    return [...types];
  };
  expect(await fire('pageswap', { navigationType: 'traverse', entry: { index: 1, url: 'http://localhost/x' } })).toEqual(['sn-traverse', 'sn-back']);
  expect(await fire('pagereveal')).toEqual(['sn-traverse', 'sn-back']);
  r.app.destroy();
  // gone with the app
  expect(await fire('pagereveal')).toEqual([]);
});

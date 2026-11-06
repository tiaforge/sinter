// The store alone: a 5,000-item collection ordered by a string field, written the way server
// events and actions write it, then read once (one flush reads the view once).
//   npm run bench
import { test } from 'vitest';
import { createResource, type Resource } from '../../src/runtime/store.js';
import { items, measure } from './page.js';

const N = 5000;
const data = items(N);

test(`store, ${N} items ordered by name`, () => {
  let r: Resource, i = 0;
  const setup = () => {
    r = createResource('rows', { key: ['id'], order: 'name' });
    r.replace(data);
    r.value();
    i = 0;
  };
  measure(`store, ${N} items ordered by name (one write or burst, then one read)`, [
    { name: 'upsert one (new name)', setup, run: () => { r.upsert({ id: i % N, name: `renamed ${i++}`, score: 1 }); r.value(); } },
    { name: 'patch one (field outside the order)', setup, run: () => { r.patch(String(i++ % N), { score: i }); r.value(); } },
    // capped, so the list never runs out of items
    { name: 'remove one', setup, runs: 2000, run: () => { r.remove(String(i++ % N)); r.value(); } },
    { name: 'burst of 50 upserts', setup, run: () => { for (let j = 0; j < 50; j++) r.upsert({ id: i++ % N, name: `renamed ${i}`, score: 1 }); r.value(); } },
    { name: 'replace all', setup, run: () => { r.replace(data); r.value(); } },
    {
      name: 'upsert one, one optimistic layer pending',
      setup: () => { setup(); r.addLayer([{ op: 'remove', key: '0' }]); },
      run: () => { r.upsert({ id: 1 + (i % (N - 1)), name: `renamed ${i++}`, score: 1 }); r.value(); },
    },
  ]);
});

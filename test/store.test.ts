import { expect, test } from 'vitest';
import { createResource } from '../src/runtime/store.js';

test('writes made while a load is in flight survive its older response', () => {
  const r = createResource<{ id: number; t: string }>('c', { key: ['id'], order: null });
  r.replace([{ id: 1, t: 'old' }]);
  const mark = r.startLoad();          // GET sent
  r.upsert({ id: 2, t: 'new' });      // POST answered, `then` upserts
  r.patch('1', { t: 'edited' });      // a server event patches
  r.replace([{ id: 1, t: 'old' }]);    // the GET answers with data from before both writes
  r.endLoad(mark, true);
  expect(r.all().map((x) => `${x.id}:${x.t}`)).toEqual(['1:edited', '2:new']);
});

test('writes before a load started are not replayed', () => {
  const r = createResource<{ id: number }>('c', { key: ['id'], order: null });
  r.upsert({ id: 1 });
  const mark = r.startLoad();
  r.replace([{ id: 2 }]);             // the server no longer has item 1
  r.endLoad(mark, true);
  expect(r.all().map((x) => x.id)).toEqual([2]);
});

test('a failed or aborted load replays nothing', () => {
  const r = createResource<{ id: number }>('c', { key: ['id'], order: null });
  const mark = r.startLoad();
  r.upsert({ id: 1 });
  r.remove('1');
  r.endLoad(mark, false);
  expect(r.all()).toEqual([]);
});

test('meta.total is current without reading the items, and a total alone marks only meta', () => {
  const r = createResource<{ id: number }>('c', { key: ['id'], order: null });
  const marks: string[] = [];
  r.onDirty = (what) => marks.push(what);
  r.replace([{ id: 1 }]);
  r.setTotal(5);
  expect(r.meta.total).toBe(5);
  expect(marks).toEqual(['data', 'meta']);
  marks.length = 0;
  r.setTotal(5);
  expect(marks).toEqual([]);
  // an optimistic removal counts against the total at once
  r.addLayer([{ op: 'remove', key: '1' }]);
  expect(r.meta.total).toBe(4);
});

test('a sorted list changed in place matches a full sort, ties in arrival order', () => {
  const r = createResource<{ id: number; n: string }>('c', { key: ['id'], order: 'n' });
  r.replace([{ id: 1, n: 'b' }, { id: 2, n: 'a' }, { id: 3, n: 'b' }]);
  expect(r.all().map((x) => x.id)).toEqual([2, 1, 3]);
  r.patch('3', { n: 'a' });          // ties with 2, which arrived first
  r.upsert({ id: 4, n: 'a' });       // a new key ties last
  r.patch('2', { n: 'a' });          // an updated key keeps its arrival place among ties
  expect(r.all().map((x) => x.id)).toEqual([2, 3, 4, 1]);
  r.remove('3');
  r.upsert({ id: 3, n: 'a' });       // removed and added again: arrives anew
  expect(r.all().map((x) => x.id)).toEqual([2, 4, 3, 1]);
});

test('a page that shows only the total updates when it loads', async () => {
  const { render, mockRequests } = await import('../src/testing/index.js');
  const requests = mockRequests({ 'GET /api/rows': { rows: [{ id: 1 }], total: 42 } });
  const { root, settle } = await render(`<sn-resource name="rows" src="/api/rows" items="rows" total="total" key="id"></sn-resource>
    <p data-sn-text="$meta.rows.total"></p>`, { requests });
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('42');
});

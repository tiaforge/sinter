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

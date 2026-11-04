import { expect, test } from 'vitest';
import { createResource, type Op } from '../src/runtime/store.js';
import { render } from '../src/testing/index.js';

/** Small seeded PRNG (mulberry32), so failures are reproducible from the seed. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random list changes: DOM order matches state, surviving rows keep their nodes', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rand = rng(seed);
    const int = (n: number) => Math.floor(rand() * n);
    const { root, app, flush } = await render(`
      <ul data-sn-state="{ items: [] }"><template data-sn-for="it in items"><li data-sn-text="it.v"></li></template></ul>`);
    const ul = root.querySelector('ul')!;
    const state = app.state(ul);
    let next = 0;
    const nodes = new Map<object, Element>();
    for (let step = 0; step < 60; step++) {
      state.update((s) => {
        const a = s.items as Array<{ v: number }>;
        const op = int(5);
        if (op <= 1 || a.length < 2) a.splice(int(a.length + 1), 0, { v: next++ });
        else if (op === 2) a.splice(int(a.length), 1);
        else if (op === 3) { const [x] = a.splice(int(a.length), 1); a.splice(int(a.length + 1), 0, x!); }
        else a.reverse();
      });
      await flush();
      const items = state.get().items as Array<{ v: number }>;
      const lis = [...ul.querySelectorAll('li')];
      expect(lis.map((l) => Number(l.textContent)), `seed ${seed} step ${step}`).toEqual(items.map((i) => i.v));
      for (const [i, li] of lis.entries()) {
        const prev = nodes.get(items[i]!);
        if (prev) expect(li, `seed ${seed} step ${step}: row ${items[i]!.v} was re-created`).toBe(prev);
        nodes.set(items[i]!, li);
      }
      // the list stays contiguous right after its anchor
      expect(ul.firstElementChild!.localName).toBe('template');
    }
  }
});

type Item = { id: string; n: number };

test('random interleavings of server writes and optimistic layers match a reference store', () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const rand = rng(seed);
    const int = (n: number) => Math.floor(rand() * n);
    const r = createResource<Item>('xs', { key: ['id'], order: 'n' });
    let base = new Map<string, Item>();
    const layers: Array<{ id: number; ops: Op[] }> = [];
    const key = () => String(int(6));
    const randomOp = (): Op => {
      const k = int(3);
      if (k === 0) return { op: 'upsert', item: { id: key(), n: int(100) } };
      if (k === 1) return { op: 'patch', key: key(), fields: { n: int(100) } };
      return { op: 'remove', key: key() };
    };
    const apply = (m: Map<string, Item>, op: Op) => {
      if (op.op === 'upsert') m.set(op.item.id, op.item);
      else if (op.op === 'patch') { const c = m.get(op.key); if (c) m.set(op.key, { ...c, ...op.fields }); }
      else m.delete(op.key);
    };
    for (let step = 0; step < 200; step++) {
      const action = int(4);
      if (action <= 1) {
        // a server event or a `then` write: always to the base
        const op = randomOp();
        apply(base, op);
        if (op.op === 'upsert') r.upsert(op.item);
        else if (op.op === 'patch') r.patch(op.key, op.fields);
        else r.remove(op.key);
      } else if (action === 2) {
        const ops = Array.from({ length: 1 + int(3) }, randomOp);
        layers.push({ id: r.addLayer(ops), ops });
      } else if (layers.length) {
        // a request settles, in any order
        const [l] = layers.splice(int(layers.length), 1);
        r.dropLayer(l!.id);
      }
      const view = new Map(base);
      for (const l of layers) for (const op of l.ops) apply(view, op);
      const expected = [...view.values()].sort((a, b) => a.n - b.n).map((i) => `${i.id}:${i.n}`);
      const got = r.all().map((i) => `${i.id}:${i.n}`);
      // equal n may tie in either order; compare as sorted multisets plus order of n
      expect(got.slice().sort(), `seed ${seed} step ${step}`).toEqual(expected.slice().sort());
      expect(r.all().map((i) => i.n), `seed ${seed} step ${step}`).toEqual([...view.values()].map((i) => i.n).sort((a, b) => a - b));
      expect(r.meta.pending).toBe(layers.length);
    }
    base = new Map();
  }
});

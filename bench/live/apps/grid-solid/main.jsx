// Solid: the rows in a store, each tick's changes in one batch; sorted through a memo.
import { createSignal, createMemo, batch, For } from 'solid-js';
import { createStore } from 'solid-js/store';
import { render } from 'solid-js/web';
import { params, initialRows, byChange, fmtPrice, fmtPct, trend } from '../../shared/grid.js';

const q = params(location.search);
function App() {
  const [seq, setSeq] = createSignal(0);
  const [rows, setRows] = createStore(initialRows(q.n));
  const view = q.sort ? createMemo(() => [...rows].sort(byChange)) : () => rows;
  new EventSource(`/events?fmt=grid&n=${q.n}&k=${q.k}`).addEventListener('tick', (e) => {
    const t = JSON.parse(e.data);
    batch(() => {
      for (const r of t.rows) setRows(r.id, { p: r.p, c: r.c, v: r.v });
      setSeq(t.seq);
    });
  });
  return <>
    <header>seq <span id="seq">{seq()}</span></header>
    <div class="grid">
      <For each={view()}>{(r) => <div class="row"><span>{r.s}</span><span>{fmtPrice(r.p)}</span><span class={trend(r.c)}>{fmtPct(r.c)}</span><span>{r.v}</span></div>}</For>
    </div>
  </>;
}
render(App, document.getElementById('app'));

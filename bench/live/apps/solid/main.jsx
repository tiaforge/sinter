// Solid: a signal per series window and for the bars, a store for the hosts (one path set per changed
// field); each tick's writes in one batch.
import { createSignal, batch, For, Index } from 'solid-js';
import { createStore } from 'solid-js/store';
import { render } from 'solid-js/web';
import { SERIES, initial, linePath, fmt1, fmt2, slide, trend } from '../../shared/model.js';

function App() {
  const init = initial();
  const [seq, setSeq] = createSignal(0);
  const series = init.series.map((s) => createSignal(s));
  const [bars, setBars] = createSignal(init.bars);
  const [hosts, setHosts] = createStore(init.hosts);
  new EventSource('/events?fmt=json').addEventListener('tick', (e) => {
    const t = JSON.parse(e.data);
    batch(() => {
      series.forEach(([get, set], k) => set(slide(get(), t.p[k])));
      setBars(t.bars);
      for (const h of t.hosts) { setHosts(h.id, 'v', h.v); setHosts(h.id, 'd', h.d); }
      setSeq(t.seq);
    });
  });
  return <>
    <header>seq <span id="seq">{seq()}</span></header>
    <section class="charts">
      {series.map(([get], k) => (
        <figure class="chart"><figcaption><span>{SERIES[k]}</span> <b>{fmt1(get()[get().length - 1])}</b></figcaption>
          <svg viewBox="0 0 240 60" preserveAspectRatio="none"><path d={linePath(get())}></path></svg></figure>
      ))}
    </section>
    <section class="bars">
      <Index each={bars()}>{(v) => <div class="bar" style={{ height: v() + '%' }}><span>{v()}</span></div>}</Index>
    </section>
    <table><tbody>
      <For each={hosts}>{(h) => <tr><td>{h.name}</td><td>{fmt1(h.v)}</td><td class={trend(h.d)}>{fmt2(h.d)}</td></tr>}</For>
    </tbody></table>
  </>;
}
render(App, document.getElementById('app'));

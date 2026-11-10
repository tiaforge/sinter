<script>
  // Svelte 5 runes: the windows and bars replaced per tick ($state.raw), the hosts a deep $state
  // changed in place.
  import { SERIES, initial, linePath, fmt1, fmt2, slide, trend } from '../../shared/model.js';
  const init = initial();
  let seq = $state(0);
  let series = $state.raw(init.series);
  let bars = $state.raw(init.bars);
  const hosts = $state(init.hosts);
  new EventSource('/events?fmt=json').addEventListener('tick', (e) => {
    const t = JSON.parse(e.data);
    series = series.map((s, k) => slide(s, t.p[k]));
    bars = t.bars;
    for (const h of t.hosts) { hosts[h.id].v = h.v; hosts[h.id].d = h.d; }
    seq = t.seq;
  });
</script>

<header>seq <span id="seq">{seq}</span></header>
<section class="charts">
  {#each series as s, k (k)}
    <figure class="chart"><figcaption><span>{SERIES[k]}</span> <b>{fmt1(s[s.length - 1])}</b></figcaption>
      <svg viewBox="0 0 240 60" preserveAspectRatio="none"><path d={linePath(s)}></path></svg></figure>
  {/each}
</section>
<section class="bars">
  {#each bars as v, i (i)}<div class="bar" style:height="{v}%"><span>{v}</span></div>{/each}
</section>
<table><tbody>
  {#each hosts as h (h.id)}<tr><td>{h.name}</td><td>{fmt1(h.v)}</td><td class={trend(h.d)}>{fmt2(h.d)}</td></tr>{/each}
</tbody></table>

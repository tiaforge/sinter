<script>
  // Svelte 5: the rows a deep $state changed in place; sorted through $derived.
  import { params, initialRows, byChange, fmtPrice, fmtPct, trend } from '../../shared/grid.js';
  const q = params(location.search);
  let seq = $state(0);
  const rows = $state(initialRows(q.n));
  const view = $derived(q.sort ? [...rows].sort(byChange) : rows);
  new EventSource(`/events?fmt=grid&n=${q.n}&k=${q.k}`).addEventListener('tick', (e) => {
    const t = JSON.parse(e.data);
    for (const r of t.rows) { const row = rows[r.id]; row.p = r.p; row.c = r.c; row.v = r.v; }
    seq = t.seq;
  });
</script>

<header>seq <span id="seq">{seq}</span></header>
<div class="grid">
  {#each view as r (r.id)}<div class="row"><span>{r.s}</span><span>{fmtPrice(r.p)}</span><span class={trend(r.c)}>{fmtPct(r.c)}</span><span>{r.v}</span></div>{/each}
</div>

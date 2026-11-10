<script setup vapor>
// Vue 3.6 Vapor mode (no virtual DOM): the rows a reactive array changed in place; sorted through computed.
import { ref, reactive, computed } from 'vue';
import { params, initialRows, byChange, fmtPrice, fmtPct, trend } from '../../shared/grid.js';
const q = params(location.search);
const seq = ref(0);
const rows = reactive(initialRows(q.n));
const view = computed(() => (q.sort ? [...rows].sort(byChange) : rows));
new EventSource(`/events?fmt=grid&n=${q.n}&k=${q.k}`).addEventListener('tick', (e) => {
  const t = JSON.parse(e.data);
  for (const r of t.rows) { const row = rows[r.id]; row.p = r.p; row.c = r.c; row.v = r.v; }
  seq.value = t.seq;
});
</script>

<template>
  <header>seq <span id="seq">{{ seq }}</span></header>
  <div class="grid">
    <div v-for="r in view" :key="r.id" class="row"><span>{{ r.s }}</span><span>{{ fmtPrice(r.p) }}</span><span :class="trend(r.c)">{{ fmtPct(r.c) }}</span><span>{{ r.v }}</span></div>
  </div>
</template>

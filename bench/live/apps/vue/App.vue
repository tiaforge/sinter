<script setup>
// Vue 3: the windows and bars replaced per tick (shallowRef), the hosts a reactive array changed in place.
import { ref, shallowRef, reactive } from 'vue';
import { SERIES, initial, linePath, fmt1, fmt2, slide, trend } from '../../shared/model.js';
const init = initial();
const seq = ref(0);
const series = shallowRef(init.series);
const bars = shallowRef(init.bars);
const hosts = reactive(init.hosts);
new EventSource('/events?fmt=json').addEventListener('tick', (e) => {
  const t = JSON.parse(e.data);
  series.value = series.value.map((s, k) => slide(s, t.p[k]));
  bars.value = t.bars;
  for (const h of t.hosts) { hosts[h.id].v = h.v; hosts[h.id].d = h.d; }
  seq.value = t.seq;
});
</script>

<template>
  <header>seq <span id="seq">{{ seq }}</span></header>
  <section class="charts">
    <figure v-for="(s, k) in series" :key="k" class="chart"><figcaption><span>{{ SERIES[k] }}</span> <b>{{ fmt1(s[s.length - 1]) }}</b></figcaption>
      <svg viewBox="0 0 240 60" preserveAspectRatio="none"><path :d="linePath(s)"></path></svg></figure>
  </section>
  <section class="bars">
    <div v-for="(v, i) in bars" :key="i" class="bar" :style="{ height: v + '%' }"><span>{{ v }}</span></div>
  </section>
  <table><tbody>
    <tr v-for="h in hosts" :key="h.id"><td>{{ h.name }}</td><td>{{ fmt1(h.v) }}</td><td :class="trend(h.d)">{{ fmt2(h.d) }}</td></tr>
  </tbody></table>
</template>

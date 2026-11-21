<state seq="0" series="[]" bars="[]" hosts="[]" />

<action name="onMount">
  const init = M.initial();
  state.series = init.series; state.bars = init.bars; state.hosts = init.hosts;
  new EventSource('/events?fmt=json').addEventListener('tick', (e) => {
    const t = JSON.parse(e.data);
    state.series = state.series.map((s, k) => M.slide(s, t.p[k]));
    state.bars = t.bars;
    for (const h of t.hosts) { state.hosts[h.id].v = h.v; state.hosts[h.id].d = h.d; }
    state.seq = t.seq;
  });
</action>

<!-- templates cannot read globals (AVX_R15), so the model's formatters are reached through actions -->
<action name="seriesName">return M.SERIES[args[0]];</action>
<action name="fmt1">return M.fmt1(args[0]);</action>
<action name="fmt2">return M.fmt2(args[0]);</action>
<action name="trend">return M.trend(args[0]);</action>
<action name="linePath">return M.linePath(args[0]);</action>

<div>
  <header>seq <span id="seq">{{ seq }}</span></header>
  <section class="charts">
    <@for s in series key="index">
      <figure class="chart"><figcaption><span>{{ seriesName(index) }}</span> <b>{{ fmt1(s[s.length - 1]) }}</b></figcaption>
        <svg viewBox="0 0 240 60" preserveAspectRatio="none"><path d="{{ linePath(s) }}"></path></svg></figure>
    </@for>
  </section>
  <section class="bars">
    <@for v in bars key="index"><div class="bar" data-ax-style="{ height: v + '%' }"><span>{{ v }}</span></div></@for>
  </section>
  <table><tbody>
    <@for h in hosts key="h.id">
      <tr><td>{{ h.name }}</td><td>{{ fmt1(h.v) }}</td><td data-ax-class="trend(h.d)">{{ fmt2(h.d) }}</td></tr>
    </@for>
  </tbody></table>
</div>

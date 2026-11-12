<state seq="0" rows="[]" sorted="false" />

<action name="onMount">
  state.sorted = Q.sort;
  state.rows = G.initialRows(Q.n);
  new EventSource(`/events?fmt=grid&n=${Q.n}&k=${Q.k}`).addEventListener('tick', (e) => {
    const t = JSON.parse(e.data);
    for (const r of t.rows) { const row = state.rows[r.id]; row.p = r.p; row.c = r.c; row.v = r.v; }
    state.seq = t.seq;
  });
</action>

<!-- templates cannot read globals (AVX_R15), so the model's helpers are reached through actions;
     `rows` stays in the template's expression so the compiler sees the dependency -->
<action name="byChange">return args[0].slice().sort(G.byChange);</action>
<action name="fmtPrice">return G.fmtPrice(args[0]);</action>
<action name="fmtPct">return G.fmtPct(args[0]);</action>
<action name="trend">return G.trend(args[0]);</action>

<div>
  <header>seq <span id="seq">{{ seq }}</span></header>
  <div class="grid">
    <@for r in (sorted ? byChange(rows) : rows) key="r.id">
      <div class="row"><span>{{ r.s }}</span><span>{{ fmtPrice(r.p) }}</span><span data-ax-class="trend(r.c)">{{ fmtPct(r.c) }}</span><span>{{ r.v }}</span></div>
    </@for>
  </div>
</div>

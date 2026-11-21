<state rows="[]" />

<action name="load">
  const v = args[0];
  fetch('/rows.json?' + Q + '&v=' + v).then((r) => r.json()).then((d) => {
    if (v === 'c') state.rows.push(...d.rows); else state.rows = d.rows;
  });
</action>

<div>
  <button id="a" @click="load('a')">a</button> <button id="b" @click="load('b')">b</button> <button id="c" @click="load('c')">c</button>
  <table><tbody id="target">
    <@for r in rows key="r.id"><tr><td class="id">{{ r.id }}</td><td class="label">{{ r.label }}</td></tr></@for>
  </tbody></table>
</div>

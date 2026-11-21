<state data="[]" selected="0" next="1" />

<action name="run">
  state.data = buildRows(state.next, 1000); state.next += 1000;
</action>
<action name="runLots">
  state.data = buildRows(state.next, 10000); state.next += 10000;
</action>
<action name="add">
  state.data = state.data.concat(buildRows(state.next, 1000)); state.next += 1000;
</action>
<action name="updateRows">
  const d = state.data; for (let i = 0; i < d.length; i += 10) d[i].label += ' !!!';
</action>
<action name="clear">
  state.data = [];
</action>
<action name="swapRows">
  const d = state.data; if (d.length > 998) { const t = d[1]; d[1] = d[998]; d[998] = t; }
</action>
<action name="select">
  state.selected = args[0];
</action>
<action name="remove">
  const d = state.data; d.splice(d.findIndex((r) => r.id === args[0]), 1);
</action>

<div class="container">
  <div class="jumbotron"><div class="row"><div class="col-md-6"><h1>Avenx (keyed)</h1></div><div class="col-md-6"><div class="row">
    <div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="run" @click="run()">Create 1,000 rows</button></div>
    <div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="runlots" @click="runLots()">Create 10,000 rows</button></div>
    <div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="add" @click="add()">Append 1,000 rows</button></div>
    <div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="update" @click="updateRows()">Update every 10th row</button></div>
    <div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="clear" @click="clear()">Clear</button></div>
    <div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="swaprows" @click="swapRows()">Swap Rows</button></div>
  </div></div></div></div>
  <table class="table table-hover table-striped test-data"><tbody>
    <@for row in data key="row.id">
      <tr data-ax-class="{ danger: row.id === selected }"><td class="col-md-1">{{ row.id }}</td><td class="col-md-4"><a @click="select(row.id)">{{ row.label }}</a></td><td class="col-md-1"><a @click="remove(row.id)"><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td><td class="col-md-6"></td></tr>
    </@for>
  </tbody></table>
</div>

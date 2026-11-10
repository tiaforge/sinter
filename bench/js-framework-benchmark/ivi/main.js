// ivi 5 reference for self.mjs: the benchmark's page as ivi's own js-framework-benchmark entry
// builds it (immutable rows, a keyed List, row components that skip unchanged rows).
import { createRoot, update, component, useReducer, html, List } from 'ivi';
import { rows } from '../src/sinter.helpers.js';

let next = 1;
const reducer = (s, a) => {
  switch (a.t) {
    case 'run': { const d = rows(next, 1000); next += 1000; return { data: d, selected: 0 }; }
    case 'runlots': { const d = rows(next, 10000); next += 10000; return { data: d, selected: 0 }; }
    case 'add': { const d = s.data.concat(rows(next, 1000)); next += 1000; return { data: d, selected: s.selected }; }
    case 'update': return { data: s.data.map((r, i) => (i % 10 ? r : { id: r.id, label: r.label + ' !!!' })), selected: s.selected };
    case 'clear': return { data: [], selected: 0 };
    case 'swaprows': {
      if (s.data.length <= 998) return s;
      const d = s.data.slice(), t = d[1]; d[1] = d[998]; d[998] = t;
      return { data: d, selected: s.selected };
    }
    case 'select': return { data: s.data, selected: a.id };
    case 'remove': return { data: s.data.filter((r) => r.id !== a.id), selected: s.selected };
  }
  return s;
};

const Row = component((c) => ({ row, selected, dispatch }) => html`
  <tr class=${selected ? 'danger' : ''}>
    <td class="col-md-1">${row.id}</td>
    <td class="col-md-4"><a @click=${() => dispatch({ t: 'select', id: row.id })}>${row.label}</a></td>
    <td class="col-md-1"><a @click=${() => dispatch({ t: 'remove', id: row.id })}><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td>
    <td class="col-md-6"></td>
  </tr>`, (a, b) => a.row === b.row && a.selected === b.selected);

const getId = (r) => r.id;
const button = (id, text, dispatch) => html`<div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id=${id} @click=${() => dispatch({ t: id })}>${text}</button></div>`;

const App = component((c) => {
  const [state, dispatch] = useReducer(c, { data: [], selected: 0 }, reducer);
  return () => {
    const { data, selected } = state();
    return html`
      <div class="jumbotron"><div class="row"><div class="col-md-6"><h1>ivi (keyed)</h1></div><div class="col-md-6"><div class="row">
        ${button('run', 'Create 1,000 rows', dispatch)}${button('runlots', 'Create 10,000 rows', dispatch)}
        ${button('add', 'Append 1,000 rows', dispatch)}${button('update', 'Update every 10th row', dispatch)}
        ${button('clear', 'Clear', dispatch)}${button('swaprows', 'Swap Rows', dispatch)}
      </div></div></div></div>
      <table class="table table-hover table-striped test-data"><tbody>${List(data, getId, (row) => Row({ row, selected: row.id === selected, dispatch }))}</tbody></table>`;
  };
});
update(createRoot(document.getElementById('main')), App());

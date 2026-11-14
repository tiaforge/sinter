// `data-sn-model` on controls other than text fields: checkboxes (a boolean, or an array of the
// checked values), radio buttons, `<select>` (one value, or `multiple`: an array), number and range
// inputs (a number, null when empty). A `<select>`'s value is set again after each render, as its
// options may have changed (one in a closed dialog waits for it to open). Loaded only by pages with
// such a model; text fields are the core's.
import type { App, Feature, ModelInner } from './runtime/app.js';

const feature: Feature = {
  name: 'models',
  install(app: App) {
    app.ext.models = ({ evaluate, deferred }: ModelInner) => {
      const selects = new Set<any>();
      const write = (rb: any, v: any) => {
        const el = rb.el as HTMLInputElement & HTMLSelectElement, k = rb.b.n;
        const has = (x: string) => Array.isArray(v) && v.map(String).includes(x);
        if (k == 'checkbox') el.checked = Array.isArray(v) ? has(el.value) : !!v;
        else if (k == 'radio') el.checked = v != null && '' + v == el.value;
        else if (k == 'multi') for (const opt of el.options) opt.selected = has(opt.value);
        // compared as numbers: '1.0' stays as typed, also where the model holds a string (`$url`)
        else if (k == 'number' ? (v == null || v === '' ? el.value !== '' : el.value === '' || +el.value != +v) : el.value != (v ?? '')) el.value = v ?? '';
      };
      return {
        write,
        /** the control's value for its model; undefined for an unchecked radio */
        read(rb) {
          const el = rb.el as HTMLInputElement & HTMLSelectElement, k = rb.b.n;
          if (k == 'number') return el.value === '' ? null : +el.value;
          if (k == 'radio') return el.checked ? el.value : undefined;
          if (k == 'multi') return [...el.selectedOptions].map((x) => x.value);
          if (k != 'checkbox') return el.value;
          const cur = evaluate(rb);
          if (!Array.isArray(cur)) return el.checked;
          const i = cur.map(String).indexOf(el.value);
          if (el.checked && i < 0) cur.push(el.value);
          if (!el.checked && i >= 0) cur.splice(i, 1);
          return cur;
        },
        bound(rb) { if (rb.el.localName == 'select') selects.add(rb); },
        forget(rb) { selects.delete(rb); },
        sync() {
          for (const rb of selects) {
            if (rb.c && rb.el.closest('dialog:not([open])')) deferred.add(rb);
            else write(rb, evaluate(rb));
          }
        },
      };
    };
  },
};
export default feature;

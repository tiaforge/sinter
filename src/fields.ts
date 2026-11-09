// Server validation errors on the fields: a form action without `data-sn-catch` whose request fails
// with a 4xx and a JSON body `{ errors: { <field>: message | message[] } }` marks each named control
// `aria-invalid="true"` and shows its message next to it: in the element the control's
// `aria-errormessage` names, else in a `<small data-sn-error>` inserted after the control (named by
// `aria-errormessage` and `aria-describedby`). The first such control gets focus. Editing a control
// clears its error; sending the form again clears them all. When every key named a control, the
// error is handled: no `sn-error`, no `onError`.
import type { App, Feature } from './runtime/app.js';
import type { SinterError } from './runtime/config.js';

type Shown = { c: Element[]; m: Element; made: boolean; hid: boolean; d: string | null; off: () => void };
const shown = new WeakMap<HTMLFormElement, Map<string, Shown>>();
let ids = 0;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v == 'object' && !Array.isArray(v);

/** The form's error entries for `error`, or null when it is not a field-error response. */
export function fieldErrors(error: SinterError): Array<[string, string]> | null {
  const e = (error.body as any)?.errors;
  const st = error.status ?? 0;
  if (st < 400 || st > 499 || !isObj(e)) return null;
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(e)) {
    const text = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '').map(String).join('; ');
    if (text) out.push([k, text]);
  }
  return out.length ? out : null;
}

function clearOne(form: HTMLFormElement, name: string) {
  const all = shown.get(form), s = all?.get(name);
  if (!s) return;
  all!.delete(name);
  s.off();
  for (const c of s.c) c.removeAttribute('aria-invalid');
  if (s.made) {
    s.m.remove();
    const c = s.c[0]!;
    c.removeAttribute('aria-errormessage');
    s.d == null ? c.removeAttribute('aria-describedby') : c.setAttribute('aria-describedby', s.d);
  } else {
    s.m.textContent = '';
    if (s.hid) s.m.setAttribute('hidden', '');
  }
}

const fields: Feature = {
  name: 'fields',
  install(app: App) {
    app.ext.fields = {
      clear(form) {
        for (const name of [...(shown.get(form)?.keys() ?? [])]) clearOne(form, name);
      },
      show(form, error) {
        const errs = fieldErrors(error);
        if (!errs || !form.isConnected) return false;
        const all = shown.get(form) ?? new Map<string, Shown>();
        shown.set(form, all);
        let every = true, first: HTMLElement | null = null;
        for (const [name, text] of errs) {
          const item = form.elements.namedItem(name);
          const c = (item instanceof Element ? [item] : item ? [...item] : []) as HTMLElement[];
          if (!c.length) { every = false; continue; }
          clearOne(form, name);
          const doc = form.ownerDocument, ref = c[0]!.getAttribute('aria-errormessage');
          let m = ref ? doc.getElementById(ref) : null;
          const made = !m, d = c[0]!.getAttribute('aria-describedby');
          if (!m) {
            m = doc.createElement('small');
            m.id = `sn-error-${++ids}`;
            m.setAttribute('data-sn-error', name);
            m.setAttribute('data-tone', 'danger');
            c.at(-1)!.after(m);
            c[0]!.setAttribute('aria-errormessage', m.id);
            c[0]!.setAttribute('aria-describedby', d ? `${d} ${m.id}` : m.id);
          }
          const hid = !made && m.hasAttribute('hidden');
          m.removeAttribute('hidden');
          m.textContent = text;
          for (const x of c) x.setAttribute('aria-invalid', 'true');
          const edit = () => clearOne(form, name);
          for (const x of c) { x.addEventListener('input', edit); x.addEventListener('change', edit); }
          all.set(name, { c, m, made, hid, d, off: () => { for (const x of c) { x.removeEventListener('input', edit); x.removeEventListener('change', edit); } } });
          if (!first || first.compareDocumentPosition(c[0]!) & Node.DOCUMENT_POSITION_PRECEDING) first = c[0]!;
        }
        // after the request's end has enabled the form's controls again
        if (first) queueMicrotask(() => first!.focus());
        return every;
      },
    };
  },
};

export default fields;

// Server validation errors on the fields: a form action (or the action of a control inside a form)
// without `data-sn-catch` fails. `configure({ fieldErrors })` reads the server's errors as
// `{ <name>: message | message[] }` (default: a 4xx whose JSON body has such an `errors` object).
// Each name that is a control of the form marks it: `aria-invalid="true"` and its messages, in the
// element its `aria-errormessage` names, else in a `<small data-sn-error>` inserted after it (named by
// `aria-errormessage` and `aria-describedby`). The first such control gets focus. Editing a control
// clears its error; sending the form again clears them all. `show` returns whether every message
// found its control. Anything else is for the form's markup: `$error` (runtime/app.ts).
import { STATE, type App, type Feature, type Tagged } from './runtime/app.js';
import { config, fieldErrors, type SinterError } from './runtime/config.js';

type Shown = { c: Element[]; m: Element; made: boolean; hid: boolean; d: string | null; off: () => void };
const shown = new WeakMap<HTMLFormElement, Map<string, Shown>>();
let ids = 0;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v == 'object' && !Array.isArray(v);

/** for apps that imported the default from here */
export { fieldErrors };

/** `[name, messages]` per name with any message. */
function entries(map: Record<string, unknown> | null | undefined): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const [k, v] of Object.entries(isObj(map) ? map : {})) {
    const msgs = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '').map(String);
    if (msgs.length) out.push([k, msgs]);
  }
  return out;
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
    const clear = (form: HTMLFormElement) => { for (const name of [...(shown.get(form)?.keys() ?? [])]) clearOne(form, name); };
    app.ext.fields = {
      sent(el, a) {
        // the form an error is about: the action's own, or the one a control (a button) belongs to
        const own = a.call ? null : a.form ? (el as HTMLFormElement) : ((el as HTMLButtonElement).form ?? null);
        if (!own) return;
        const form = a.catch == null && a.method != 'GET' ? own : null;
        if (form) clear(form);
        // the form's `$error`: a state field the compiler adds when its markup reads it
        const fe = (own as Tagged)[STATE], st = fe && '$error' in fe[1] ? fe : null;
        const set = (v: SinterError | null) => { if (st && st[1].$error !== v) { st[1].$error = v; app.mark('$s' + st[0] + '.$error'); } };
        set(null);
        return (error, request) => {
          const marked = !!form && show(form, error, request);
          set(error);
          return marked || !!st;
        };
      },
    };
    function show(form: HTMLFormElement, error: SinterError, request: { url: string; method: string }): boolean {
      if (!form.isConnected) return false;
      const errs = entries((config.fieldErrors ?? fieldErrors)(error, request));
      const all = shown.get(form) ?? new Map<string, Shown>();
      shown.set(form, all);
      let every = errs.length > 0;
      let first: HTMLElement | null = null;
      for (const [name, msgs] of errs) {
        const item = name ? form.elements.namedItem(name) : null;
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
        m.textContent = msgs.join('; ');
        for (const x of c) x.setAttribute('aria-invalid', 'true');
        const edit = () => clearOne(form, name);
        for (const x of c) { x.addEventListener('input', edit); x.addEventListener('change', edit); }
        all.set(name, { c, m, made, hid, d, off: () => { for (const x of c) { x.removeEventListener('input', edit); x.removeEventListener('change', edit); } } });
        if (!first || first.compareDocumentPosition(c[0]!) & Node.DOCUMENT_POSITION_PRECEDING) first = c[0]!;
      }
      // after the request's end has enabled the form's controls again
      if (first) queueMicrotask(() => first!.focus());
      return every;
    }
  },
};

export default fields;

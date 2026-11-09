// Server validation errors on the fields: a form action (or the action of a control inside a form)
// without `data-sn-catch` fails. `configure({ fieldErrors })` reads the server's errors as
// `{ <name>: message | message[] }`; it returns `undefined` to leave that to the default, a 4xx whose
// JSON body has such an `errors` object. Each name that is a control of the form marks it:
// `aria-invalid="true"` and its messages, in the element its `aria-errormessage` names, else in a
// `<small data-sn-error>` inserted after it (named by `aria-errormessage` and `aria-describedby`). The
// first such control gets focus. Editing a control clears its error; sending the form again clears
// them all. The form's `$error` (a state field the compiler adds when its markup reads it) is null
// while the form is sent and the error after a failure.
import { STATE, type App, type Feature, type Tagged } from './runtime/app.js';
import { config, type SinterError } from './runtime/config.js';

/** per form, per marked name: what undoes the mark */
const marks = new WeakMap<HTMLFormElement, Map<string, () => void>>();
let ids = 0;

/** The default reading: a 4xx whose JSON body's `errors` is an object (Rails, Laravel, RealWorld, ASP.NET). */
const byDefault = (e: SinterError) => {
  const s = e.status!, b = (e.body as any)?.errors;
  return s > 399 && s < 500 && b && typeof b == 'object' && !Array.isArray(b) ? b : null;
};

function unmark(form: HTMLFormElement, name: string) {
  const all = marks.get(form), undo = all?.get(name);
  if (undo) { all!.delete(name); undo(); }
}

/** Marks the controls `c` of `name` with `text`; returns what undoes it. */
function mark(form: HTMLFormElement, name: string, c: HTMLElement[], text: string): () => void {
  const doc = form.ownerDocument, x = c[0]!, ref = x.getAttribute('aria-errormessage'), d = x.getAttribute('aria-describedby');
  let m = (ref ? doc.getElementById(ref) : null) as HTMLElement | null;
  const made = !m, hid = !!m?.hidden;
  if (!m) {
    m = doc.createElement('small');
    m.id = `sn-error-${++ids}`;
    m.dataset.snError = name;
    m.dataset.tone = 'danger';
    c.at(-1)!.after(m);
    x.setAttribute('aria-errormessage', m.id);
    x.setAttribute('aria-describedby', d ? `${d} ${m.id}` : m.id);
  }
  m.hidden = false;
  m.textContent = text;
  const off = new AbortController(), edit = () => unmark(form, name);
  for (const y of c) {
    y.setAttribute('aria-invalid', 'true');
    y.addEventListener('input', edit, off);
    y.addEventListener('change', edit, off);
  }
  return () => {
    off.abort();
    for (const y of c) y.removeAttribute('aria-invalid');
    if (made) {
      m!.remove();
      x.removeAttribute('aria-errormessage');
      d == null ? x.removeAttribute('aria-describedby') : x.setAttribute('aria-describedby', d);
    } else {
      m!.textContent = '';
      m!.hidden = hid;
    }
  };
}

const fields: Feature = {
  name: 'fields',
  install(app: App) {
    app.ext.fields = {
      sent(el, a) {
        // the form an error is about: the action's own, or the one a control (a button) belongs to
        const own = a.call ? null : a.form ? (el as HTMLFormElement) : (el as HTMLButtonElement).form;
        if (!own) return;
        const form = a.catch == null && a.method != 'GET' ? own : null;
        const all = marks.get(own) ?? new Map<string, () => void>();
        marks.set(own, all);
        if (form) for (const name of [...all.keys()]) unmark(form, name);
        const fe = (own as Tagged)[STATE], st = fe && '$error' in fe[1] ? fe : null;
        const set = (v: SinterError | null) => { if (st && st[1].$error !== v) { st[1].$error = v; app.mark(`$s${st[0]}.$error`); } };
        set(null);
        return (error, request) => {
          set(error);
          if (!form?.isConnected) return !!st;
          const map = config.fieldErrors?.(error, request);
          let any = false, every = true, first: HTMLElement | null = null;
          for (const [name, v] of Object.entries((map === undefined ? byDefault(error) : map) ?? {})) {
            const text = [v].flat().filter((x) => x != null && x !== '').join('; ');
            if (!text) continue;
            any = true;
            const item = name ? form.elements.namedItem(name) : null;
            const c = (item instanceof Element ? [item] : item ? [...item] : []) as HTMLElement[];
            if (!c.length) { every = false; continue; }
            unmark(form, name);
            all.set(name, mark(form, name, c, text));
            if (!first || first.compareDocumentPosition(c[0]!) & Node.DOCUMENT_POSITION_PRECEDING) first = c[0]!;
          }
          // after the request's end has enabled the form's controls again
          if (first) queueMicrotask(() => first!.focus());
          // shown: every message on its field, or the form's markup reads `$error`
          return (any && every) || !!st;
        };
      },
    };
  },
};

export default fields;

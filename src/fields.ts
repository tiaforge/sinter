// Server validation errors on the form: a form action (or the action of a control inside a form)
// without `data-sn-catch` fails. `configure({ fieldErrors })` reads the server's errors as
// `{ <name>: message | message[] }` (default: a 4xx whose JSON body has such an `errors` object).
// - A name that is a control of the form: the control gets `aria-invalid="true"` and its message,
//   in the element its `aria-errormessage` names, else in a `<small data-sn-error>` inserted after
//   it (named by `aria-errormessage` and `aria-describedby`). The first such control gets focus.
// - Everything else is about the form: messages under a name no control has, under `''`, or, when
//   nothing was read as field errors, the error's `detail` (else its `message`). They go into the
//   form's `data-sn-errors` element (inside the form, or naming the form's id): a `<ul>`/`<ol>` gets
//   an `<li>` per message, any other element the messages as text.
// Editing a control clears its error; sending the form again clears everything. The error is handled
// (no `sn-error`, no `onError`) when every message found its place.
import type { App, Feature } from './runtime/app.js';
import { config, fieldErrors } from './runtime/config.js';

type Shown = { c: Element[]; m: Element; made: boolean; hid: boolean; d: string | null; off: () => void };
const shown = new WeakMap<HTMLFormElement, Map<string, Shown>>();
/** the form-level messages shown: the slot, what was added to it, whether it was hidden */
const slots = new WeakMap<HTMLFormElement, { el: Element; added: Node[]; hid: boolean }>();
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

/** The form's `data-sn-errors` element: inside it, or one that names its id. */
function slotOf(form: HTMLFormElement): Element | null {
  return form.querySelector('[data-sn-errors=""]')
    ?? (form.id ? form.ownerDocument.querySelector(`[data-sn-errors="${CSS.escape(form.id)}"]`) : null);
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

function clearSlot(form: HTMLFormElement) {
  const s = slots.get(form);
  if (!s) return;
  slots.delete(form);
  for (const n of s.added) (n as ChildNode).remove();
  if (s.hid) s.el.setAttribute('hidden', '');
}

const fields: Feature = {
  name: 'fields',
  install(app: App) {
    app.ext.fields = {
      clear(form) {
        for (const name of [...(shown.get(form)?.keys() ?? [])]) clearOne(form, name);
        clearSlot(form);
      },
      show(form, error, request) {
        if (!form.isConnected) return false;
        const errs = entries((config.fieldErrors ?? fieldErrors)(error, request));
        const all = shown.get(form) ?? new Map<string, Shown>();
        shown.set(form, all);
        // what no control takes is about the form; nothing read as field errors: the error itself
        const rest: string[] = errs.length ? [] : [error.detail ?? error.message];
        let first: HTMLElement | null = null;
        for (const [name, msgs] of errs) {
          const item = name ? form.elements.namedItem(name) : null;
          const c = (item instanceof Element ? [item] : item ? [...item] : []) as HTMLElement[];
          if (!c.length) { rest.push(...msgs); continue; }
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
        if (!rest.length) return true;
        const el = slotOf(form);
        if (!el) return false;
        clearSlot(form);
        const doc = form.ownerDocument, list = el.localName == 'ul' || el.localName == 'ol';
        const added = list
          ? rest.map((t) => { const li = doc.createElement('li'); li.textContent = t; return li; })
          : [doc.createTextNode(rest.join('; '))];
        el.append(...added);
        slots.set(form, { el, added, hid: el.hasAttribute('hidden') });
        el.removeAttribute('hidden');
        return true;
      },
    };
  },
};

export default fields;

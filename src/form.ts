// Form bodies: a form's own fields as the request body (nested JSON, FormData with a file input),
// and `data-sn-encoding="form"` (application/x-www-form-urlencoded). Loaded only by pages with a
// form action without `data-sn-body`, or with an action that encodes as a form.
import type { App, Feature } from './runtime/app.js';
import { BAD_KEY } from './runtime/keys.js';

/**
 * A body as form fields (`data-sn-encoding="form"`): a form's own fields, or an object's keys with
 * arrays as repeated keys; null and undefined values are left out. Files stay multipart.
 */
export function formBody(body: unknown): URLSearchParams | FormData | null {
  if (body == null) return null;
  if (body instanceof FormData) {
    const out = new URLSearchParams();
    for (const [k, v] of body) {
      if (typeof v != 'string') return body;
      out.append(k, v);
    }
    return out;
  }
  if (body instanceof URLSearchParams) return body;
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    for (const x of Array.isArray(v) ? v : [v]) if (x != null) out.append(k, typeof x == 'object' ? JSON.stringify(x) : String(x));
  }
  return out;
}

/** Serializes a form's named controls to nested JSON, or FormData if it has a file input. */
export function serialize(form: HTMLFormElement): unknown {
  const controls = [...form.elements] as Array<HTMLInputElement & { selectedOptions: HTMLCollectionOf<HTMLOptionElement> }>;
  if (controls.some((c) => c.type == 'file')) return new FormData(form);
  const out = Object.create(null), boxes: Record<string, number> = {};
  for (const c of controls) if (c.type == 'checkbox') boxes[c.name] = (boxes[c.name] ?? 0) + 1;
  for (const c of controls) {
    const { name, type } = c, segs = name?.match(/[^.[\]]+/g);
    if (!segs || c.disabled || /^(submit|button|reset|image|fieldset|output)$/.test(type) || (type == 'radio' && !c.checked) || segs.some((s) => BAD_KEY.test(s))) continue;
    const k = segs.pop()!;
    let o = out;
    // a container at each step; a scalar written there earlier (`a`, then `a.b`) is replaced
    segs.forEach((s, i) => (o = typeof o[s] == 'object' && o[s] ? o[s] : (o[s] = /^\d+$/.test(segs[i + 1] ?? k) ? [] : Object.create(null))));
    if (type == 'checkbox' && boxes[name]! > 1) (o[k] ??= []).push(...(c.checked ? [c.value] : []));
    else o[k] = type == 'checkbox' ? c.checked
      : /^(number|range)$/.test(type) ? (c.value === '' ? null : +c.value)
      : type == 'select-multiple' ? [...c.selectedOptions].map((x) => x.value)
      : c.value;
  }
  return out;
}

const feature: Feature = {
  name: 'form',
  install(app: App) {
    // a form's own action without `data-sn-body` (not GET or DELETE) sends its fields
    app.ext.form = (el, a, body) => {
      if (a.form && a.body == null && a.method != 'GET' && a.method != 'DELETE') body = a.enc ? new FormData(el as HTMLFormElement) : serialize(el as HTMLFormElement);
      return a.enc ? formBody(body) : body;
    };
  },
};
export default feature;

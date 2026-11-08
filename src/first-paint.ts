// First paint: what the page shows before its module has run. The compiler writes bindings whose
// value is known at build time into the HTML (in the fallback locale), and leaves what depends on
// the visitor — the locale, persisted values — to this script: a classic script with no imports,
// loaded `defer blocking="render"` before the page module. It reads the page's
// `<script type="application/json" id="sn-first-paint">`, sets `<html lang>` to the locale it
// picks, writes that locale's values and the persisted values of model-bound controls.
// FIRST_PAINT_SCRIPT is its source; `firstPaint` and `pickLocale` are what it runs.

/** One write: `[data-sn id, kind, name, value]`; kinds as the runtime's bindings, `checked`/`value` for controls. */
export type FirstPaintWrite = [number, 'text' | 'attr' | 'class' | 'style' | 'show' | 'checked' | 'value', string | null, unknown];

/** The page's first-paint data (`#sn-first-paint`). */
export interface FirstPaintData {
  /** the app's locales (the first is the fallback the HTML is written in), the localStorage key with the visitor's choice, whether navigator.languages count */
  l?: { locales: string[]; storage?: string | null; navigator?: boolean };
  /** writes per locale, where the locale's value differs from the fallback's */
  t?: Record<string, FirstPaintWrite[]>;
  /** persisted controls: `[id, persist key, control kind, field of a persisted state object]` */
  p?: Array<[number, string, string, string?]>;
}

/** The first supported locale among the stored choice and the browser's languages (exact, then by language), else the first one. */
export function pickLocale(locales: string[], stored: string | null | undefined, languages: readonly string[]): string {
  const find = (l: string | null | undefined): string | undefined => {
    if (!l) return undefined;
    const x = l.toLowerCase();
    return locales.find((s) => s.toLowerCase() == x) ?? locales.find((s) => s.toLowerCase() == x.split('-')[0]);
  };
  let hit = find(stored);
  for (let i = 0; !hit && i < languages.length; i++) hit = find(languages[i]);
  return hit ?? locales[0]!;
}

/** Applies the page's first-paint data to `doc`. Self-contained: its source becomes the script. */
export function firstPaint(doc: Document, storage: Storage | null, languages: readonly string[], pick: typeof pickLocale): void {
  const json = doc.getElementById('sn-first-paint');
  if (!json) return;
  const data: FirstPaintData = JSON.parse(json.textContent!);
  const els: Record<string, HTMLElement> = {};
  doc.querySelectorAll<HTMLElement>('[data-sn]').forEach((e) => { els[e.getAttribute('data-sn')!] = e; });
  const read = (key: string): string | null => { try { return storage ? storage.getItem(key) : null; } catch { return null; } };
  const l = data.l;
  if (l) {
    const locale = pick(l.locales, l.storage ? read(l.storage) : null, l.navigator === false ? [] : languages);
    doc.documentElement.lang = locale;
    for (const [id, k, n, v] of (data.t && data.t[locale]) || []) {
      const el = els[id] as HTMLInputElement | undefined;
      if (!el) continue;
      if (k == 'text') el.textContent = v as string;
      else if (k == 'attr') { if (v == null) el.removeAttribute(n!); else el.setAttribute(n!, v as string); }
      else if (k == 'class') el.classList.toggle(n!, !!v);
      else if (k == 'style') { if (v == null) el.style.removeProperty(n!); else el.style.setProperty(n!, v as string); }
      else if (k == 'show') el.hidden = !v;
      else if (k == 'checked') el.checked = !!v;
      else el.value = v as string;
    }
  }
  // as the persist feature and the model's write do when the module runs
  for (const [id, key, kind, field] of data.p || []) {
    const el = els[id] as (HTMLInputElement & HTMLSelectElement) | undefined;
    const raw = read('sn:' + key);
    if (!el || raw == null) continue;
    let v: any;
    try { v = JSON.parse(raw); } catch { continue; }
    if (field != null) {
      if (!v || typeof v != 'object' || !Object.prototype.hasOwnProperty.call(v, field)) continue;
      v = v[field];
    }
    if (v === undefined) continue;
    const has = (x: string) => Array.isArray(v) && v.map(String).indexOf(x) >= 0;
    if (kind == 'checkbox') el.checked = Array.isArray(v) ? has(el.value) : !!v;
    else if (kind == 'radio') el.checked = v != null && '' + v == el.value;
    else if (kind == 'multi') for (const o of el.options) o.selected = has(o.value);
    else el.value = v == null ? '' : v;
  }
}

/** The script's source: runs `firstPaint` on the document; a failure leaves the page as built. */
export const FIRST_PAINT_SCRIPT = `/* sinter first paint */(function(){try{var s=null;try{s=localStorage}catch(e){}var n=navigator,l=n.languages&&n.languages.length?n.languages:[n.language||''];(${firstPaint.toString()})(document,s,l,${pickLocale.toString()})}catch(e){}})();\n`;

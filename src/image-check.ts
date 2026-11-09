// Dev only: a script the dev server adds to every page. When an image has loaded (and after a
// resize), it compares the pixels of the file the browser chose with the device pixels the image
// covers, and warns in the console when the file is too small: a source with too few pixels, or
// a `sizes` smaller than the image is shown (so the browser picked a smaller file than it has).
// CSS backgrounds too: the file `url()` or `image-set()` gives (chosen as the browser chooses),
// drawn at the size `background-size` makes it. Builds never include it. See docs/images.md.
export const IMAGE_CHECK = `const warned = new Set();
const density = () => window.devicePixelRatio || 1;
const largest = (img) => {
  const els = [img, ...(img.parentElement && img.parentElement.localName === 'picture' ? img.parentElement.querySelectorAll('source') : [])];
  let max = 0;
  for (const el of els) for (const c of (el.getAttribute('srcset') || '').split(',')) {
    const m = /\\s(\\d+)w\\s*$/.exec(c.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
};
const check = (img) => {
  if (!img.complete || !img.currentSrc) return;
  const box = img.getBoundingClientRect();
  if (box.width < 8 || box.height < 8) return;
  const src = img.currentSrc, probe = new Image();
  probe.onload = () => {
    const fw = probe.naturalWidth, fh = probe.naturalHeight;
    if (!fw || !fh) return;
    // the width of the file the box shows: cover scales it up to the larger side, contain to the smaller
    const fit = getComputedStyle(img).objectFit, r = fw / fh;
    const shown = fit === 'cover' ? Math.max(box.width, box.height * r) : fit === 'contain' || fit === 'scale-down' ? Math.min(box.width, box.height * r) : box.width;
    const need = Math.round(shown * density());
    if (fw >= need * 0.9) return;
    const key = src + ' ' + need;
    if (warned.has(key)) return;
    warned.add(key);
    const max = largest(img);
    console.warn('sinter: an image is shown ' + Math.round(box.width) + ' px wide (' + need + ' device px at ' + density() + 'x) from a file ' + fw + ' px wide, so it looks soft. '
      + (max > fw ? 'Its srcset has a ' + max + ' px file: its sizes ("' + (img.sizes || '100vw') + '") is smaller than the image is shown; write the width it is shown at.' : 'Use a larger source, at least ' + need + ' px wide.'), img);
  };
  probe.src = src;
};

// ---- CSS backgrounds
const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
// formats this browser decodes (image-set() skips the others)
const AVIF = 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=';
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const supported = Promise.all([load(AVIF), load(WEBP)]).then(([a, w]) => ({ 'image/avif': !!a, 'image/webp': !!w }));
/** the top-level comma-separated parts of a computed value */
const layers = (v) => { const out = []; let depth = 0, cur = '', q = ''; for (const ch of v) { if (q) { if (ch === q) q = ''; cur += ch; continue; } if (ch === '"' || ch === "'") q = ch; if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
const urlOf = (s) => { const m = /^url\\(\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|([^)]*?))\\s*\\)/.exec(s) || /^"((?:[^"\\\\]|\\\\.)*)"/.exec(s); return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : null; };
/** the candidate the browser uses: a url(), or the image-set() option of a decoded type at the resolution nearest at or above the screen's */
const candidate = (layer, types) => {
  if (/^url\\(/i.test(layer)) { const u = urlOf(layer); return u ? { url: u, res: 1, set: false } : null; }
  const m = /^(?:-webkit-)?image-set\\((.*)\\)$/is.exec(layer);
  if (!m) return null;
  const options = layers(m[1]).map((o) => {
    const url = urlOf(o.replace(/^image\\(/i, ''));
    const type = /type\\(\\s*["']([^"']+)["']\\s*\\)/i.exec(o);
    // Chromium writes '1dppx' before type(): anywhere after the image
    const r = /\\s(\\d*\\.?\\d+)(x|dppx|dpi|dpcm)(?=\\s|$)/i.exec(o);
    const res = r ? Number(r[1]) / (r[2].toLowerCase() === 'dpi' ? 96 : r[2].toLowerCase() === 'dpcm' ? 96 / 2.54 : 1) : 1;
    return { url, res, type: type && type[1].toLowerCase() };
  }).filter((o) => o.url && (!o.type || types[o.type] !== false));
  if (!options.length) return null;
  options.sort((a, b) => a.res - b.res);
  const pick = options.find((o) => o.res >= density()) || options[options.length - 1];
  return { url: pick.url, res: pick.res, set: true };
};
/** the width (CSS px) a layer is drawn at in a w × h area, for a file of iw × ih CSS px */
const drawn = (size, iw, ih, w, h) => {
  const s = size.trim().toLowerCase();
  if (s === 'cover') return iw * Math.max(w / iw, h / ih);
  if (s === 'contain') return iw * Math.min(w / iw, h / ih);
  const [a = 'auto', b = 'auto'] = s.split(/\\s+/);
  const len = (v, of) => (v === 'auto' ? null : v.endsWith('%') ? (parseFloat(v) / 100) * of : parseFloat(v));
  const x = len(a, w), y = len(b, h);
  if (x !== null) return x;
  if (y !== null) return y * (iw / ih);
  return iw;
};
const checkBackground = async (el) => {
  const cs = getComputedStyle(el);
  if (!cs.backgroundImage || cs.backgroundImage === 'none') return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  // the positioning area: the padding box, unless background-origin says otherwise
  const px = (v) => parseFloat(v) || 0;
  const origins = layers(cs.backgroundOrigin), sizes = layers(cs.backgroundSize), types = await supported;
  const images = layers(cs.backgroundImage);
  for (let i = 0; i < images.length; i++) {
    const c = candidate(images[i], types);
    if (!c) continue;
    const origin = origins[i % origins.length] || 'padding-box';
    let w = rect.width, h = rect.height;
    if (origin !== 'border-box') { w -= px(cs.borderLeftWidth) + px(cs.borderRightWidth); h -= px(cs.borderTopWidth) + px(cs.borderBottomWidth); }
    if (origin === 'content-box') { w -= px(cs.paddingLeft) + px(cs.paddingRight); h -= px(cs.paddingTop) + px(cs.paddingBottom); }
    const file = await load(new URL(c.url, document.baseURI).href);
    if (!file || !file.naturalWidth) continue;
    const fw = file.naturalWidth, fh = file.naturalHeight;
    const shown = drawn(sizes[i % sizes.length] || 'auto', fw / c.res, fh / c.res, w, h);
    const need = Math.round(shown * density());
    if (fw >= need * 0.9) continue;
    const key = c.url + ' ' + need;
    if (warned.has(key)) continue;
    warned.add(key);
    console.warn('sinter: a background image is drawn ' + Math.round(shown) + ' px wide (' + need + ' device px at ' + density() + 'x) from a file ' + fw + ' px wide, so it looks soft. '
      + (c.set ? 'The build counts a CSS background as a 2x image (half its width for 1x screens): use a source at least ' + Math.round(2 * shown) + ' px wide, twice the largest width it is drawn at.' : 'Use a larger source, at least ' + need + ' px wide.'), el);
  }
};
const backgrounds = () => { for (const el of document.querySelectorAll('body, body *')) checkBackground(el); };

const all = () => { document.querySelectorAll('img').forEach(check); backgrounds(); };
document.addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement) check(e.target); }, true);
if (document.readyState === 'complete') all(); else addEventListener('load', all);
let t;
const later = () => { clearTimeout(t); t = setTimeout(all, 300); };
addEventListener('resize', later);
// elements rendered later (rows from data, a class that changes the background)
new MutationObserver(later).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
`;

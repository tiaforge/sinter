// Dev only: a script the dev server adds to every page. When an image has loaded (and after a
// resize), it compares the pixels of the file the browser chose with the device pixels the image
// covers, and warns in the console when the file is too small: a source with too few pixels, or
// a `sizes` smaller than the image is shown (so the browser picked a smaller file than it has).
// Builds never include it. See docs/images.md.
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
const all = () => document.querySelectorAll('img').forEach(check);
document.addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement) check(e.target); }, true);
if (document.readyState === 'complete') all(); else addEventListener('load', all);
let t;
addEventListener('resize', () => { clearTimeout(t); t = setTimeout(all, 300); });
`;

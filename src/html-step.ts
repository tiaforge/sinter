// Vite's HTML step (`vite:build-html`) parses every page to find what it bundles or rewrites, and for a page with
// none of it writes the page as it came in. A built page that needs none of it can skip the parse (vite.ts: the page
// is stored before the step and put back in it, `SN_HTML_SKIP`); this says which pages those are. It errs on the side
// of the step: a page with anything the step reads or rewrites, or anything this does not recognise, goes through it.
//
// What the step does to a page (Vite 8, `buildHtmlPlugin`, and the hooks it runs), each one checked here:
// - `%NAME%` replaced by an env value (`htmlEnvHook`): no `%…%` at all;
// - its placeholders replaced (`__VITE_ASSET__`, `__VITE_PUBLIC_ASSET__`, `__VITE_INLINE_CSS__`): no `__VITE_`;
// - `vite-ignore` attributes removed: none;
// - module scripts bundled and replaced by the chunk's tags, classic scripts' `src` from the public directory, their
//   `import()`s resolved, an import map moved: no `<script>` but the Speculation Rules without `import`;
// - `<style>` and `style` attributes with `url()`/`image-set()` moved into the bundle's CSS: no `<style`, no `url(` or
//   `image-set(` anywhere;
// - asset URLs of `audio`, `embed`, `img`, `image`, `input`, `object`, `source`, `track`, `use`, `video` (src, srcset,
//   href, data, poster): none of these elements;
// - `<link href>` (a stylesheet into the bundle, icons and the like hashed or from the public directory) and
//   `imagesrcset`: only links to another origin (`https://…`, `//…`) or `data:`/`#`, no `imagesrcset`;
// - `<meta content>` of the image names and properties it lists (`og:image`, `twitter:image`, `msapplication-…`):
//   none of those.
// The app-wide ones (a CSP nonce, `build.cssCodeSplit: false`, `build.chunkImportMap`, extra asset sources, another
// plugin's HTML hook) are checked by the plugin.

const ENV = /%(\S+?)%/;
const ASSET_ELEMENTS = /<(?:audio|embed|img|image|input|object|source|track|use|video|style)(?=[\s/>])/i;
const TAG = (name: string) => new RegExp(`<${name}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'gi');
const SCRIPT = /<script(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const EXTERNAL = /^([a-z]+:)?\/\//;
const META_IMAGE = /^(?:msapplication-|twitter:image|og:(?:image|audio|video))/i;

/** an element's attributes (names lowercased; `&amp;` and `&quot;` decoded, enough for the URLs read here) */
function attrsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(ATTR)) out.set(m[1]!.toLowerCase(), (m[2] ?? m[3] ?? m[4] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  return out;
}

/** whether Vite's HTML step can change this built page, or might (in doubt: true) */
export function viteStepNeeded(html: string): boolean {
  if (ENV.test(html) || html.includes('__VITE_') || /vite-ignore/i.test(html) || /url\(|image-set\(/i.test(html) || ASSET_ELEMENTS.test(html)) return true;
  // the scripts: the Speculation Rules only (a classic inline script, which the step scans for `import()`)
  let scripts = 0;
  for (const m of html.matchAll(SCRIPT)) {
    scripts++;
    const a = attrsOf(m[1]!);
    if (a.size !== 1 || a.get('type') !== 'speculationrules' || /import/i.test(m[2]!)) return true;
  }
  // a `<script` the pattern above did not read whole (no end tag, an odd attribute): in doubt
  if ((html.match(/<script(?=[\s/>])/gi) ?? []).length !== scripts) return true;
  for (const m of html.matchAll(TAG('link'))) {
    const a = attrsOf(m[1]!), href = a.get('href');
    if (a.has('imagesrcset') || a.has('vite-ignore')) return true;
    if (href && !(href[0] === '#' || EXTERNAL.test(href) || /^\s*data:/i.test(href))) return true;
  }
  if ((html.match(/<link(?=[\s/>])/gi) ?? []).length !== [...html.matchAll(TAG('link'))].length) return true;
  for (const m of html.matchAll(TAG('meta'))) {
    const a = attrsOf(m[1]!);
    if (META_IMAGE.test(a.get('name')?.trim() ?? '') || META_IMAGE.test(a.get('property')?.trim() ?? '')) return true;
  }
  if ((html.match(/<meta(?=[\s/>])/gi) ?? []).length !== [...html.matchAll(TAG('meta'))].length) return true;
  return false;
}

/** what Vite's step is given instead of a page it does not change: it parses this, and the page is put back after */
export const STEP_STAND_IN = '<!doctype html><html><head></head><body></body></html>';

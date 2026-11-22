// For a component script that builds elements itself (instead of through its template's bindings): the checks
// `data-sn-attr` and `data-sn-style` apply, so that what the script writes is held to the same rules as markup.

import { config } from './config.js';
import { schemesOf, STYLE_BAD, urlAllowed } from './security.js';

let extra: string[] | null = null, schemes: Set<string> = schemesOf([]);

/**
 * Whether `value` may be written to attribute `name` of `el`, as `data-sn-attr` would write it: a URL attribute
 * (`href`, `src`, `srcset`, `action`, …) only with an allowed scheme (http(s), mailto, tel, the app's
 * `configure({ urlSchemes })`; `data:` and `blob:` only as an image's or a media element's `src`), a relative one
 * by the page's base URL. Any other attribute is allowed: the caller decides which attributes an element may carry.
 */
export function attrAllowed(el: Element, name: string, value: string): boolean {
  if (config.urlSchemes !== extra) { extra = config.urlSchemes; schemes = schemesOf(extra); }
  return urlAllowed(el, name, value, document.baseURI, schemes);
}

/** Whether `value` may be set as a style property, as `data-sn-style` would set it: nothing that can load a URL (`url()`, `image-set()`, escapes). */
export function styleAllowed(value: string): boolean {
  return !STYLE_BAD.test(value);
}

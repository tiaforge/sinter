# Security

sinter never creates HTML from data. Every remaining way data can reach the DOM is closed at build
time or checked at runtime, and the core uses no Trusted Types sinks, so pages run under
`require-trusted-types-for 'script'` and without `unsafe-eval`.

You do not configure any of this. This guide lists what is enforced, so you know what the build
error or the removed attribute means, and what stays your job.

## Sinks and how each is closed

| Sink | Risk | Rule |
| --- | --- | --- |
| `data-sn-text` | none | `textContent` only |
| `data-sn-attr` names | event handlers such as `onclick` | keys must be literal; computed keys, spread (`...obj`) and `on*` names are `SN207` |
| `data-sn-attr` URL values | `javascript:` links and forms | runtime scheme allowlist, see [URL attributes](#url-attributes) |
| `data-sn-attr` `style`, `srcdoc` | CSS injection, HTML | `SN207`; styles go through `data-sn-style` |
| `data-sn-attr` `id`, `name` from data | DOM clobbering of other scripts | warning `SN503` |
| `data-sn-style` | CSS that loads URLs | literal property names, no spread; values set with `style.setProperty`; values containing `url(`, `image(`, `image-set(` or a backslash are rejected at runtime |
| `data-sn-prop` | `innerHTML` and friends | only on custom elements; literal keys, no spread; `innerHTML`, `outerHTML`, `srcdoc` are `SN207` |
| `data-sn-class` | applying arbitrary existing classes | computed keys allowed (low risk); sets classes only, never other attributes |
| any binding on `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta>`, `<link>` or SVG `<animate>`, `<set>`, `<animateMotion>`, `<animateTransform>` | script execution, page takeover | `SN207` |
| `data-sn-attr="{ content: … }"` on a `<meta>` with a literal `name`, `property` or `itemprop` | none: a description or `og:title` is text to the browser | allowed; any other key, any other attribute, and any binding on a `<meta http-equiv>` (a refresh, a policy) or `<meta charset>` is `SN207` |
| URL templates of resources, actions and streams | requests to an attacker-chosen origin, leaked headers | see [Requests and origins](#requests-and-origins) |
| store merges, form serialization, `patch` fields, `$url` | prototype pollution | keys `__proto__`, `constructor` and `prototype` are dropped; objects built from input have a null prototype |
| `data-sn-persist` | secrets left in localStorage | `SN207` on `type="password"` and on fields with `autocomplete` `cc-*`, `one-time-code`, `current-password` or `new-password` |

Build errors carry a code; see docs/diagnostics.md. To show markup, bind data to a custom element's
property with `data-sn-prop`, and let that element decide how to render it.

## URL attributes

`href`, `src`, `action`, `formaction`, `poster`, `cite`, `data`, `ping` and `xlink:href` are
checked when a binding sets them, and so is every candidate in `srcset`.

- Allowed: `http:`, `https:`, `mailto:`, `tel:` and relative URLs. `data:` and `blob:` only in `src`
  of `img`, `video`, `audio` and `source`.
- A rejected value removes the attribute; dev builds warn with the element and the value.
- The scheme is read as the URL standard reads it, so leading spaces or control characters, tabs
  inside the scheme and mixed case cannot disguise `javascript:`. A relative URL is judged by the
  scheme of the element's base URL.
- `configure({ urlSchemes: ['webcal:'] })` adds schemes. `javascript:`, `vbscript:` and `data:`
  outside media can never be added.
- Only the scheme is checked. A protocol-relative `//other.example` or an `https:` URL to another
  origin is allowed, as in static HTML. If a link target must stay on your site, check that in the
  helper that builds it.

## No runtime template processing

Frameworks that process directives found in the live DOM run any directive that server-rendered
user content contains (client-side template injection). sinter cannot have this bug: directives
exist only at build time, and the runtime never reads a `data-sn-*` attribute. Markup with
directives that gets injected into a page is inert HTML.

The runtime reads only the `data-sn` ids the build assigned, and checks them at mount:

- Each id must appear exactly once, on an element with the tag the build recorded. A missing,
  duplicate or mismatched id is not bound, and dev builds report it.
- Embedded data (`data-sn-data`) is accepted only from `<head>`, once per resource name. Anything
  else is ignored with a dev error.
- The runtime never reads named properties of `window` or `document`, the pattern behind most DOM
  clobbering gadgets.
- Configuration comes only from `configure()` in JavaScript, never from the DOM, so injected markup
  cannot change request scope, headers or schemes.

## Requests and origins

- A URL template must start with a literal same-origin path (`/` followed by a non-slash) or an
  origin you listed. A leading interpolation or `//` is `SN207`. This closes the bug where a full
  URL in a parameter replaces the intended base.
- At runtime, a resolved URL whose origin is neither the page's nor a listed one is refused and
  reported through `onError`. List origins in `sinter({ origins: [...] })`; see
  docs/configuration.md.
- Interpolated values are encoded with `encodeURIComponent`; a value that is exactly `.` or `..`
  becomes `%2E` or `%2E%2E`, so it cannot climb path segments.
- Header middleware such as a CSRF header applies to same-origin requests only, unless you scope it
  to a listed origin. A CSRF token does not leak to third-party hosts.
- Stream URLs of `<sn-sync>` follow the same rules.

## Client state is untrusted

`data-sn-state`, `$url` and persisted values can be changed by the visitor in the browser, and
`$url` by anyone who sends them a link. Validate every request on the server as if the page did not
exist.

Persisted keys are namespaced `sn:`. They are cleared by `loginRedirect`; call `clearPersisted()`
on logout. The page-load cache and next-page data entries (in `sessionStorage`) are cleared on any
401 and by `clearPersisted()` too.

## Outside sinter's control

- Islands, your helpers and `onError` handlers are trusted code. Do not pass server data, including
  `$error.message`, to HTML sinks (`innerHTML`) from them.
- Embedded JSON must be serialized with `<` written as `<`, so it cannot close its
  `<script>`. `sinter-axum` does this.
- The server rejects state-changing requests that lack the CSRF header, never changes state on
  `GET`, and never answers credentialed CORS requests for arbitrary origins (which would defeat
  the header check).
- Send JSON with `Content-Type: application/json` and `X-Content-Type-Options: nosniff`.
- A page with sensitive data restored from the back/forward cache after logout is caught by a
  session probe on `pageshow`, before any stream reconnects. A server that must never show such a
  page again sends `Cache-Control: no-store`.
- Expressions are code you wrote. Their sandbox is a guardrail against mistakes, not a security
  boundary.

## CSP and Trusted Types

Expressions are compiled at build time, so a policy needs no `unsafe-eval`. The core writes no
HTML, so `require-trusted-types-for 'script'` works without a policy of your own. The browser test
suite runs with Trusted Types enforced and a strict CSP, and fails on any violation report.

What the build adds to the page and how it fits a strict policy:

- **Scripts and fonts are files.** Page scripts, the early scripts and bundled Google Fonts CSS are
  separate files, so `script-src 'self'` and `style-src 'self'` are enough.
- **Speculation Rules** are an inline `<script type="speculationrules">`. A CSP in a `<meta>` gets
  their hash added by the build; a CSP sent as a response header needs
  `'inline-speculation-rules'` in `script-src`, or deliver the rules as a file with
  `speculation: { delivery: 'header' }`. See [navigation.md](navigation.md#speculation-rules-and-a-content-security-policy).
- **Embedded data** (`<script type="application/json">`) is data, not executed, so a script-src
  policy does not apply to it.

## Supply chain and build

- The runtime has no dependencies; the compiler has few, pinned and reviewed on update. The package
  has no install scripts.
- Releases are published only from CI with npm trusted publishing and provenance; maintainer
  accounts use 2FA and hold no long-lived publish tokens.
- The compiler uses a spec-compliant HTML parser (the browsers' algorithm, no regular expressions)
  and serializes from that tree, so the compiler and the browser agree on which element an
  attribute belongs to.
- Component files are read from `src/components/` inside the project root only, symlinks included.

## Related

- [first-paint.md](first-paint.md): embedded data and early requests.
- docs/attributes.md: every binding, with its rules.

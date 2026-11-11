# Pages without JavaScript

A page ships JavaScript only if something on it runs in the browser. A page built from a layout,
components and text, with no data and nothing interactive, is complete in its HTML and gets no
script at all: no page module, no early script, no runtime. A site that is static on some pages and
an app on others gets both: the runtime is one shared file that only the pages that need it load.

There is nothing to turn on. The build decides it per page and says so:

```
sinter: index.html: no JavaScript
sinter: contact.html: JavaScript 0.4 kB gzip + 14.1 kB gzip shared: `data-sn-on-submit` (contact.html:12), resource `countries` (contact.html:3)
```

The second line names the first few things that run in the browser on that page, and where each was
written: in the page, a component or the layout.

## What is static

Whatever can never change is written into the HTML at build time and carries nothing in the
browser ([build-time constants](first-paint.md#build-time-constants)):

- literals, and a component's props given as literals: `<site-header data-sn-prop="{ title: 'About' }">`
- `data-sn-state` fields that nothing on the page writes: `{ nav: 'about' }` read by a nav link's class
- `data-sn-if` over those, decided at build time
- `data-sn-for` over a constant list, unrolled into its rows, when the rows read only the item, its
  index and constants:

  ```html
  <!-- src/components/nav-list.html -->
  <template data-sn-component="{ items: { href: string; label: string }[] }">
    <ul><template data-sn-for="i in items"><li><a data-sn-attr="{ href: i.href }" data-sn-text="i.label"></a></li></template></ul>
  </template>

  <!-- the page -->
  <nav-list data-sn-prop="{ items: [{ href: '/', label: 'Home' }, { href: '/about.html', label: 'About' }] }"></nav-list>
  ```

  is `<ul><li><a href="/">Home</a></li><li><a href="/about.html">About</a></li></ul>` in the built page.
  A row with a handler, a model, its own state or a nested loop, and a list over 1,000 items, stay a
  template that the runtime renders.

## What needs JavaScript

Anything that runs in the browser keeps the runtime on its page:

| On the page | Why |
| --- | --- |
| a binding over state a handler, a model or a `then` writes | it changes |
| a binding over `$url`, `$now`, `$locale`, a helper or a built-in formatter | the browser computes it |
| `<sn-resource>`, `<sn-sync>`, an action (`data-sn-post`, `data-sn-call`, …) | it talks to your API |
| a handler (`data-sn-on-click`, key shortcuts), `data-sn-model`, `data-sn-persist`, `data-sn-listbox` | it reacts to the visitor |
| a component with a script (`src/components/<name>.ts`) | its script runs |
| messages that switch language in the browser (`m.*`) | the language is picked in the browser |
| `data-sn-transition`, images from the API through a resizing service | they need code |

A script the page or its layout writes itself (`<script type="module" src="./main.ts">`) is the
app's: it stays, and Vite bundles it as usual, without the runtime.

## Making sure a page stays static

On a docs site, one `data-sn-on-click` in the footer would put the runtime back on every page,
quietly. List the pages that must ship no JavaScript in the plugin's options:

```js
// vite.config.js
sinter({ static: ['index.html', 'about.html', 'docs/**'] })
sinter({ static: true })   // every page
```

Paths are relative to the root: `*` matches within one folder, `**` across folders. A listed page
that needs the runtime fails the build with [SN322](diagnostics.md#sn322-ships-javascript), once for
each thing that runs, where it was written:

```
src/components/site-footer.html:3:29 error SN322 ships-javascript: about.html must ship no JavaScript (`sinter({ static })`), but `data-sn-on-click` runs in the browser
```

`sinter check` and the editor report it too. A pattern that matches no page is a build error, so
that renaming a page cannot drop it from the check unnoticed.

## What a page without JavaScript does not do

- **The config module does not run.** `src/sinter.config.ts` configures sinter (request middleware,
  `onError`, `locale`, …), and sinter does not run on the page, so neither does it. Code meant for
  every page, such as an analytics snippet, goes in a script the layout includes.
- **The early module does not run either.** `src/sinter.early.ts` is shared by every page of the app
  and runs before sinter renders; on a page where sinter renders nothing, it is left out.
- **Next-page data is not prefetched.** When a visitor rests the pointer on a link to a page with
  data, sinter's runtime requests that page's data, so it shows at once. A static page has no runtime,
  so a data page opened from it loads its data after one round trip, as on a first visit. Speculation
  Rules still work, since they are not JavaScript: the browser fetches the next page's HTML, and with
  `sinter({ speculation: 'prerender' })` Chromium loads the whole next page, data included, before the
  click ([navigation](navigation.md)).

## Your own scripts

A static page ships no script of sinter's, and the app's global modules (the config module and the
early module) stay out. A script the page or its layout writes is the page's own: it always ships,
and it does not count against `sinter({ static })`.

| Code that should run | Write it as |
| --- | --- |
| after the page is parsed: analytics, a widget, a small interaction | `<script type="module" src="./about.ts">`, bundled by Vite: in the layout's head for every page, or in one page through the layout's head slot (`<script slot="head" type="module" src="./about.ts">`) |
| before the first paint: a theme class from `localStorage`, so the page does not flash | a classic script inline in the layout's head: `<script>document.documentElement.dataset.theme = localStorage.theme ?? 'light'</script>` |

A module script runs after the page is parsed, too late for code that must change the first paint,
and Vite bundles only module scripts; so pre-paint code is inline (or a classic script from
`public/`, served as written). With a Content Security Policy, an inline script needs its hash (or
`'unsafe-inline'`) in `script-src`.

The dev server serves the same pages as the build: no page module on a static page, its components'
styles as a stylesheet.

## Page URLs

Every page with a fixed path is written as a directory's index: `about.html` is `about/index.html` in
the build, and its URL is `/about/`. `docs/getting-started.html` is `docs/getting-started/index.html`
at `/docs/getting-started/`. This is the one URL form there is, on every page, static or not.

It works on any static server without configuration: serving a directory's `index.html` is what nginx,
Apache, GitHub Pages, S3's website hosting and the hosts that do clean URLs all do, and they redirect
`/about` to `/about/`. (One exception: a CDN that reads a storage bucket without its website mode,
such as CloudFront in front of plain S3, finds `index.html` only at the root; turn on the bucket's
website hosting, or add a function that appends `index.html`.) `vite dev` and `vite preview` serve the
same URLs.

What the build does with it:

- **Links name the URL.** A link to one of your pages, written with its file (`<a href="/about.html">`,
  `<a href="../about.html">`) or its URL (`/about/`), is written as `/about/`, root-relative or
  relative as you wrote it, so following it costs no redirect. This holds for links in the markup and
  in bindings the build writes into the HTML (a nav from a constant prop).
- **Relative URLs keep pointing where they did.** In `about/index.html`, `<img src="img/logo.svg">`
  would look in `/about/img/`; the build rewrites it to `../img/logo.svg`.
- **The old URL keeps working.** `about.html` is still in the build, as a redirect to `/about/` (a
  refresh with a canonical link and `noindex`), so links to your site from before still arrive. With
  scripts on it keeps the query and fragment: `/task.html?id=3` arrives at `/task/?id=3`.
- **`index.html`, `404.html` and `200.html` stay as they are**: hosts look for them by name.
- **Two files for one URL fail the build**: `docs.html` and `docs/index.html` would both be `/docs/`.

### Which URLs a page answers at

A page without `data-sn-path` answers at its directory URL, as above. A page with `data-sn-path`
answers at exactly the paths it lists, and its file stays where it is:

```html
<!-- article.html: /article/hello -->      <html data-sn-path="/article/:slug">
<!-- editor.html: /editor, /editor/x -->    <html data-sn-path="/editor /editor/:slug">
<!-- index.html: /, /tag/news -->           <html data-sn-path="/ /tag/:tag">
<!-- login.html: /login, no slash -->       <html data-sn-path="/login">
<!-- help.html: three paths -->             <html data-sn-path="/help /support /faq">
```

Paths are absolute, from the site's root (with Vite's `base`, as in `/docs/article/:slug`), and a
pattern also matches with a trailing slash. `$url` has the `:name` segments. A `data-sn-path` that
names only the URL a page has anyway (`/contact/` on `contact.html`) is
[SN515](diagnostics.md#sn515-redundant-path), and ignored. Any other URL scheme is your reverse
proxy's business.

### Redirects and rewrites

The build writes the rules for your pages into `_redirects`, the file Netlify and Cloudflare Pages
read, after your own rules from `public/_redirects`:

```
/about.html  /about/  301
/support  /help  200
/faq  /help  200
/tag/:tag  /  200
/article/:slug  /article  200
/editor/:slug  /editor  200
```

A 301 for each page's old file URL, and a rewrite for each path a page declares, except the one a host
serves its file at anyway (`/login` for `login.html`, `/editor` for `editor.html`). Rewrites point to the
file's own path (`/article`), which both hosts serve from `article.html`. `sinter({ redirects: false })`
leaves the file out. Cloudflare Pages reads at most 2,000 fixed rules and 100 with patterns; the build
warns above that.

The same rules are followed by `vite dev`, by `vite preview` (which reads the built `_redirects`), and
by [sinter-axum](../packages/sinter-axum/README.md), which has them from the build's manifest: a 301 for
an old file URL with its query, a declared path served from its page's file, with its data embedded.

On Netlify a rule does not apply where a file exists, and `about.html` exists: it is the redirect
file, so an old URL arrives through its refresh rather than a 301 there. (A forced rule, `301!`, would
be ignored by Cloudflare Pages, which reads one file with Netlify.) Search engines treat an instant
refresh as a permanent redirect.

For other servers, write the same rules in their syntax, one per line of `_redirects`:

```nginx
# nginx
location = /about.html { return 301 /about/$is_args$args; }
location ~ ^/article/[^/]+/?$ { try_files /article.html =404; }
```

```apache
# Apache (.htaccess)
Redirect 301 /about.html /about/
RewriteEngine On
RewriteRule ^article/[^/]+/?$ /article.html [L]
```

```
# Caddy
redir /about.html /about/ permanent
rewrite /article/* /article.html
```

```json
// Vercel (vercel.json)
{ "redirects": [{ "source": "/about.html", "destination": "/about/", "permanent": true }],
  "rewrites": [{ "source": "/article/:slug", "destination": "/article.html" }] }
```

A host that reads no rules still serves every page at its directory URL, and old file URLs through the
redirect files; pages with `data-sn-path` then need the host's own rewrites.

A link your page builds at run time is not rewritten: write it as the URL
(`data-sn-attr="{ href: '/task/?id=' + t.id }"`). The build warns when a page's code still names a page
by its file (`'/task.html?id='`), which works, but through the redirect.

## Canonical URLs

Tell the build the site's origin, and every page gets a canonical link, and expressions get two names:

```js
// vite.config.js
export default { base: '/docs/', plugins: [sinter({ site: 'https://example.com' })] };
```

| Name | What it is | `guide/install.html`, opened as `/docs/guide/install/?tab=npm` |
| --- | --- | --- |
| `$site` | the site's root URL: the origin, then Vite's `base`, no trailing slash | `https://example.com/docs` |
| `$canonical` | the page's URL: `$site` and the page's path, no query | `https://example.com/docs/guide/install/` |
| `$url` | unchanged: the query and the `data-sn-path` parameters | `{ tab: 'npm' }` |

```html
<meta property="og:url" data-sn-attr="{ content: $canonical }">
<meta property="og:image" data-sn-attr="{ content: $site + '/og/install.png' }">
```

On a page with a fixed path both are constants, written into the HTML at build time, so the page still
ships no JavaScript. Each such page gets `<link rel="canonical" href="…">` with `$canonical`, last in its
head. A page that writes its own canonical link keeps it (content that lives at another URL), and
`$canonical` is then that link's URL; it must be absolute. On a page whose path is a pattern
(`/article/:slug`), `$canonical` is the origin and the browser's path without a trailing slash, rendered
by the early script; with embedded data (`embed: true`), [sinter-axum](../packages/sinter-axum/README.md)
writes the page's canonical link into the HTML for each request.

`site` is an origin only: a site served under a path sets Vite's `base`. Without `site`, reading
`$site` or `$canonical` is [SN323](diagnostics.md#sn323-needs-site), and no canonical link is written.


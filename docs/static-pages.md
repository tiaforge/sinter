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

- literals, and a component's props given as literals: `<site-header data-sn-with="{ title: 'About' }">`
- `data-sn-state` fields that nothing on the page writes: `{ nav: 'about' }` read by a nav link's class
- `data-sn-if` over those, decided at build time
- `data-sn-for` over a constant list, unrolled into its rows, when the rows read only the item, its
  index and constants:

  ```html
  <!-- src/components/nav-list.html -->
  <template data-sn-props="{ items: { href: string; label: string }[] }">
    <ul><template data-sn-for="i in items"><li><a data-sn-attr="{ href: i.href }" data-sn-text="i.label"></a></li></template></ul>
  </template>

  <!-- the page -->
  <nav-list data-sn-with="{ items: [{ href: '/', label: 'Home' }, { href: '/about.html', label: 'About' }] }"></nav-list>
  ```

  is `<ul><li><a href="/">Home</a></li><li><a href="/about.html">About</a></li></ul>` in the built page.
  Loops inside the rows are unrolled the same way, at any depth (a list of sections, each with its
  links), and a `data-sn-if` in a row is decided per row. A row with a handler that writes state, a
  model or its own state, and a nested loop that is not constant, stay a template that the runtime
  renders. A list has no length limit of its own: its rows count against the page's (below).
- trees over constants: a component used inside itself, and the component an `<sn-component use>`
  renders, given constant props (a `file:./doc.json` content tree, each node dispatched to its
  component) are expanded at build time, per node, and a link fill is written into every node that
  places it: an element, an if/else chain, a component tag, and a fill whose `<slot>` places the
  node's own children. The page is plain HTML, and a component nothing renders leaves it. Two fills
  render in the browser: one that holds a component with slots of its own (a tree inside the fill),
  and one that a wrapper component passes on with `<slot name="…" slot="…">`; on a static page,
  [SN322](diagnostics.md#sn322-ships-javascript) names the fill and why.
- a handler that reads only constants, `$el` and `$event` (a copy button) does not stop any of it:
  the page ships that handler and the runtime it needs, nothing else.

At most 10,000 rows and components are expanded per page, a list's rows included; the list or tree that
would cross it is rendered in the browser, with warning [SN536](diagnostics.md#sn536-expansion-limit). Each costs about
0.2 ms of compile, in the build and in the editor, which compiles a page on every edit; a site that
measures a bigger page as fast enough sets its own limit with `sinter({ expansionLimit: 25000 })`.

## Helpers and files at build time

A helper call over constants runs at build time, and its result is written into the page:
`data-sn-text="slug(title)"` over a constant `title`, a list `data-sn-for="t in tags(post)"` that
unrolls, a `data-sn-state` field initialized by a helper. Whether a helper can run there is decided
from its code: it, and everything it calls and imports, may use only JavaScript's own deterministic
globals (`Math`, `JSON`, `Array`, `Map`, …) and `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`
and `structuredClone`, not `Date`, `Intl`, `Math.random`, `fetch`, `window` or `process`; each exported function counts on its own. Handlers never run at build time.

- A helper that throws at build time, or returns something that is not plain data (a `Date`, a
  `Map`, a class), stays in the browser; a dev build warns at the call (`SN534`). Every build runs each
  call twice and keeps one whose results differ in the browser, and a production build also runs every
  page's calls again at its end, in a fresh copy of the helpers module and in another page order, and fails
  (`SN534`) on a result that differs: a helper that keeps state between calls (a table of ids, a
  counter) would give each page what the build's page order made of it. A helper must be pure; a
  cache that only remembers is fine.
- Also refused: `import.meta` in any form (a URL built from it would be the build machine's path),
  `.constructor` and `__proto__`, `Math` or `Reflect` used as a value (`const M = Math`,
  `const { random } = Math`, `Reflect.get(Math, 'random')`; `Math.max(…)` and `Math.PI` are fine), an
  error's `.stack`, and a function that assigns a module-level variable (`count++`).
- **This is a guard against mistakes, not a sandbox.** It reads your code to tell whether a call
  gives the same result in the build as in the browser, and it catches the usual ways that fails.
  Code written to get around it can, and it runs in the build with the build machine's access, as
  any build plugin or dependency does. Keep untrusted code out of your helpers' imports.
- `src="file:./intro.txt"` resources ([resources.md](resources.md#files)) are constants too: bindings
  over them, and helpers called over them, are written into the page, and a file nothing in the
  browser reads leaves the page. A page whose files and helpers all fold ships no JavaScript.

## What needs JavaScript

Anything that runs in the browser keeps the runtime on its page:

| On the page | Why |
| --- | --- |
| a binding over state a handler, a model or a `then` writes | it changes |
| a binding over `$url`, `$now`, `$locale` or a built-in formatter | the browser computes it |
| a binding that calls a helper that cannot run at build time (it reads the clock, the locale, the browser, …) | the browser computes it; `SN322` names the helper and what it reaches |
| `<sn-resource>`, `<sn-sync>`, an action (`data-sn-post`, `data-sn-call`, …) | it talks to your API |
| a handler (`data-sn-on-click`, key shortcuts), `data-sn-model`, `data-sn-persist`, `data-sn-options` | it reacts to the visitor |
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
  `sinter({ prefetch: { html: { prerender: true } } })` Chromium loads the whole next page, data included, before the
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

### A page per entry

`data-sn-for` on `<html>` builds a page once per entry of a list the page reads from the repository, and writes each at
its `data-sn-path` pattern filled from the entry:

```html
<!-- blog/post.html -->
<site-layout data-sn-path="/blog/:slug" data-sn-for="post in posts" data-sn-with="{ title: post.title }">
  <sn-resource name="posts" src="file:/content/posts/*.md" type="Post"></sn-resource>
  <article>
    <h1 data-sn-text="post.title"></h1>
    <md-doc data-sn-with="{ doc: md.parse(post.body) }"></md-doc>
  </article>
</site-layout>
```

```
dist/blog/hello.html      /blog/hello
dist/blog/recap.html      /blog/recap
```

- **The list** is a [`file:` glob](resources.md#files) the page declares, outside any template: one entry per
  file, with its frontmatter's fields, `body`, `slug`, `dir` and `path`. `order` and `drafts` apply.
- **The entry** (`post`) is a constant in the whole page, its head, layout and slots included, as a resource
  is: components get it through props. Everything over it is written at build time, so each page ships no
  JavaScript unless something on it runs (a live resource for its comments is fine: it loads in the browser).
  `sinter check` types it as one item of the list: `post.titel` is an error.
- **Its URL**: each `:param` of the pattern is the entry's field of that name, a string or a number that is
  one path segment, encoded as the sitemap encodes it (`A b` is `A%20b`). An entry that cannot fill it, or two
  that fill one path, are [SN340](diagnostics.md#sn341-entry-param). The page has exactly that one pattern
  ([SN340](diagnostics.md#sn340-entry-path)).
- **A file at its path**, as any page with an exact `data-sn-path`: `blog/hello.html` at `/blog/hello`, which
  hosts serve without a rule, so `_redirects` has none for it. Its canonical link is written at build time,
  and the sitemap lists every entry (no `sitemap.paths` for the pattern). The template (`blog/post.html`) is
  not written: nothing answers at it. A path another page or a file in `public/` has fails the build.
- **Speculation Rules** name the pattern once (`/blog/:slug`), not each entry.
- **The pattern's parameters are the entry's.** `$url.slug` on such a page is
  [SN345](diagnostics.md#sn345-url-param-entry): read `post.slug`, known at build time (a query parameter, `$url.tab`,
  is fine). A list or tree on it too long to write at build time ([SN536](diagnostics.md#sn536-expansion-limit)) is an error here,
  not a warning: one long entry would ship its content and the runtime.
- **An index in pages** is a collection of pages, built with `chunks()`
  ([collections](resources.md#collections)), and a page per entry (`data-sn-for` on `<html>`) at `/blog/page/:n`; the front page
  (`/blog/`) is a page of its own.
- **Links to entries are checked**: a link in a built page to a path the pattern matches but no entry has
  (`/blog/helo`) fails the build with the entry it was likely meant for
  ([SN343](diagnostics.md#sn343-broken-entry-link)). The links are the built HTML's, so those from markdown and
  folded expressions count; a link built in the browser at run time does not.
- **The dev server** serves each entry at its URL, from the template, compiled with that entry.
- **With [`localePrefix`](#languages)**, each language builds its own entries: a list with `{$locale}` in its
  path (`file:/content/{$locale}/posts/*.md`) reads each language's folder, at that language's prefix
  (`/de/blog/hallo`). Entries are translations of each other when their key is equal (`key="id"` with an `id` in
  the frontmatter, since slugs may be translated): `localeUrl('de')` and the `hreflang` alternates name the German
  one, and an entry one language does not have has no page there and no alternate. Each entry's unprefixed path
  (the base language's) is a language chooser, to the visitor's language's translation, else the base's.

A page per entry is for content the repository holds; data that changes on its own stays a pattern page with a
live resource (one file for every slug, its data loaded in the browser or embedded by the
[server layer](server.md)).

### A site per tenant: axes

`data-sn-for` on `<html>` takes several lists, outer first, separated by `;`. Every list but the page's own
entries (the last, when the page has a `data-sn-path` pattern to fill) is an **axis**: the page is built once per
entry of it, under the entry's key. A layout declares an axis for every page that uses it:

```html
<!-- src/layouts/shop-layout.html -->
<html lang="en" data-sn-for="tenant in tenants" data-sn-props="{ title: string }">
<head><title data-sn-text="tenant.name + ' · ' + title"></title></head>
<body>
  <sn-resource name="tenants" src="content:tenants"></sn-resource>
  <nav><a href="/index.html">Home</a> <a href="/about.html">About</a></nav>
  <main><slot></slot></main>
</body>
</html>
```

```html
<!-- blog/post.html: a page per entry inside each tenant -->
<shop-layout data-sn-path="/blog/:slug" data-sn-for="post in posts" data-sn-with="{ title: post.title }">
  <sn-resource name="posts" src="file:/content/{tenant.key}/posts/*.md"></sn-resource>
  <h1 data-sn-text="post.title"></h1>
</shop-layout>
```

```
dist/acme/index.html          /acme/
dist/acme/about/index.html    /acme/about/
dist/acme/blog/hello.html     /acme/blog/hello
dist/globex/index.html        /globex/
```

- **The list** is a collection (`content:tenants`) or a `file:` glob; each entry's key is its path segment.
- **The item** (`tenant`) is a constant of the whole page, as an entry is: written into the HTML, readable in an inner
  list's `file:` path (`{tenant.key}`).
- **Links stay in the point**: a link to one of your pages from acme's page is acme's (`/about.html` is
  `/acme/about/`); a page outside the axis (one that does not use the layout) is linked as itself.
- **With [`localePrefix`](#languages)** the language is outside every axis (`/de/acme/about/`), `hreflang` pairs a
  tenant's pages across languages, and the chooser is at the tenant's path without a language (`/acme/about/`).
- **Content per tenant**: `collection({ key, per: [tenants], load: ({ value }) => … })` is loaded once per tenant
  (`value(tenants)` is the tenant), and each page reads its own tenant's list as `content:<name>`. `per` may name the
  `languages()` collection too (`per: [tenants, locales]`: `ctx.locale` is the language), and a page reads its
  language's. The page's axis list must come before such a resource in the merged document (the layout's list before
  its slot).
- **A tenant on its own domain**: an entry with an `origin` (`{ key: 'acme', origin: 'https://acme-shop.com' }`) is
  written under its key's folder, `dist/acme/` (its languages inside, `dist/acme/de/about/index.html`), and every URL
  in its pages is that domain's: links (`/de/about/`), the canonical link and `hreflang` (`https://acme-shop.com/…`),
  its next-page data and swaps (its own pages only), a sitemap of its own (`dist/acme/sitemap.xml`) and the language
  chooser at its root. The reverse proxy maps the domain to the folder; the shared files stay at the root:

  ```nginx
  server {
    server_name acme-shop.com;
    root /srv/site/dist;
    location /assets/ { }
    location / { try_files /acme$uri /acme$uri/index.html /acme$uri.html =404; }
  }
  ```

  The site's `_redirects` leave such a tenant's pages out (a host that reads them serves one domain). In dev, a tenant
  with an origin is served under its key, as a segment (`/acme/de/about/`).
- Not yet ([docs/proposals/axes.md](proposals/axes.md), step 6): absolute links between origins, the server layers'
  host map, and a build error for a link from a page outside the axis to a page only an axis has.

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
(`data-sn-href="/task/?id={t.id}"`). The build warns when a page's code still names a page
by its file (`/task.html?id=`), which works, but through the redirect.

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
(`/article/:slug`), one file answers every URL, so `$canonical` is the origin and the browser's path
without a trailing slash (each article is its own canonical URL; the query is left out), written by the
early script in the head before the first paint, and so is the page's canonical link, when the page
ships JavaScript anyway (a page that reads `$url` does). Search engines that run JavaScript read it; a
crawler or preview bot that does not sees no canonical link (a URL is then its own) and no `og:url`.
A server never fills it: sinter's middlewares route and serve files, they do not rewrite pages.

`site` is an origin only: a site served under a path sets Vite's `base`. Without `site`, reading
`$site` or `$canonical` is [SN323](diagnostics.md#sn323-needs-site), and no canonical link is written.

## Sitemap

With `site`, the build writes `sitemap.xml` at the root of the output. Nothing else is needed:

```
sinter: sitemap.xml: 7 URLs; left out: secret.html (noindex), article.html /article/:slug (no values in sitemap.paths)
```

It holds every page a search engine should index, at the URL its canonical link names, the same URL
`$canonical` is:

- **Each page with a fixed URL**: `/about/` for `about.html`, `/login` for `data-sn-path="/login"`, under
  Vite's `base`.
- **Not** `404.html` or `200.html`, a page whose head has `<meta name="robots" content="noindex">` (or
  `none`, from the page, its layout or a head component), or a page whose own canonical link names
  another URL.
- **With [languages](#languages)**, each language's URL, with every language and the chooser as
  alternates (`<xhtml:link rel="alternate" hreflang>`, the same links the pages' heads have). The choosers
  are `noindex` and not in it.

The XML has `<loc>` and the alternates only. Search engines ignore `priority` and `changefreq`, and a
`lastmod` the build would guess would be wrong.

### Pages whose path has parameters

The build does not know the slugs of `/article/:slug`: they are your data. Give them by pattern, as the
page's `data-sn-path` writes it, with a list or a function the build calls once (it may be async, and ask
your API):

```js
sinter({
  site: 'https://example.com',
  sitemap: {
    paths: {
      '/article/:slug': async () => (await fetch('https://api.example.com/articles?fields=slug').then((r) => r.json())).map((a) => a.slug),
      '/blog/:year/:slug': [{ year: '2026', slug: 'hello' }],
    },
  },
})
```

A value is a string for a pattern with one parameter, or an object with every parameter by name. Each is
encoded as a path segment (`a b` is `a%20b`). With languages, a pattern is written without the prefix,
as in `data-sn-path`, and each value gives a URL in every language.

- A pattern without values is left out, and the build's line names it.
- A pattern on a page that also has a fixed path (`data-sn-path="/editor /editor/:slug"`) is left out:
  the page's canonical link names its fixed URL at every path it answers at.
- A pattern no page has, a value that does not fill its pattern, or a function that throws or returns
  no list, fails the build.

### Turning it off, or writing your own

`sitemap: false` leaves the file out. A `public/sitemap.xml` of your own is kept, and the build writes
none. With a relative `base` (`'./'`) the build does not know the URLs the site is served at, and writes
none. Past 50,000 URLs, the protocol's limit for one file, `sitemap.xml` is a sitemap index, and the URLs
are in `sitemap-1.xml`, `sitemap-2.xml`, ….

Tell search engines where it is in `robots.txt` (in `public/`, which sinter leaves to you):

```
Sitemap: https://example.com/sitemap.xml
```

## Languages

With [messages](messages.md) in more than one language, `localePrefix` builds each page once
per language, under that language's prefix, with its text in the HTML:

```js
// vite.config.js
sinter({ localePrefix: true, site: 'https://example.com' })
```

```
dist/en/about/index.html    /en/about/    <html lang="en">, English in the HTML
dist/de/about/index.html    /de/about/    <html lang="de">, German in the HTML
dist/about/index.html       /about/       a language chooser
dist/index.html             /             a language chooser
```

The languages come from the inlang project: `locales` are the prefixes, and `baseLocale` (which must be
set, and among `locales`) is the language a visitor without a choice gets. Every language is prefixed,
the base too, so a server routes on the first segment alone.

A site without messages declares its languages in the [content module](resources.md#collections) instead, and
`localePrefix` works with `messages: false`:

```ts
// src/sinter.content.ts
import { languages } from '@tiaforge-ui/sinter/content';
export const locales = languages({ base: 'en', list: ['en', 'de'] });
```

`base` must be one of `list`, and each is a language tag. With the built-in messages too, the inlang project must
list the same languages, or the build fails naming both lists. The content module has one `languages()`.

**Fallback chains.** A message missing in a language is looked up along its chain, at build: its tag less its last
subtag, one at a time, where the site has that language, then the base (`de-AT → de → en`). `languages({ fallbacks:
{ 'de-CH': ['de-AT', 'de'] } })` replaces a language's chain before the base. SN522 reports the keys that reach the
base, and how many came from another language of the chain.

**Choosing a visitor's language** (the chooser pages, `@tiaforge-ui/sinter/server`, sinter-axum, Sinter.AspNetCore):
for each tag the visitor sends, in order (the `locale` cookie, then `Accept-Language` or `navigator.languages`), the
site's language with that tag, else with the tag less its subtags (`zh-Hant-TW` reaches `zh-Hant`), else the first
site language with the same language part (`de` reaches `de-DE`); else the base.

In each language's page:

- **Its text is in the HTML.** `m.title()`, `$locale`, and anything built from them and constants are
  written at build time, in text and attributes (`<title>`, `<meta content>`, `aria-label`), so a page
  with nothing else to run ships no JavaScript in any language. A page that runs loads no language file
  either: a message its code still needs (`m.inbox_count({ count: inbox.unread })`, or `m.loading()` in an
  expression over data) is compiled into its script as that language's text, and the messages your own
  modules call (`m.hello()` in a helper) are written into the page, in `<script type="application/json"
  data-sn-messages>`. `number()`, `bytes()` and `date()` of a calendar date (`'2026-11-11'`) are written at
  build time too; a moment (`'2026-11-11T09:00:00Z'`) is the visitor's time zone's, formatted in the browser.
- **Switching language is a link.** `localeUrl('de')` is this page's URL in German:

  ```html
  <a hreflang="de" data-sn-attr="{ href: localeUrl('de'), 'aria-current': $locale === 'de' ? 'true' : null }">Deutsch</a>
  ```

  `$locale` cannot be assigned (`SN203`): each language is its own page.
- **Links stay in the language.** A link to one of your pages (`/about.html`, `/about/`) is written as that
  page in the same language (`/de/about/`). A link with `hreflang` names a language on purpose and is left
  as it is. A link template (`data-sn-href="/article/{a.slug}"`) whose literal start names one of your pages
  (fixed or a pattern) gets the language's prefix in its code too (`/de/article/…`), as does the API's `token.signIn`
  when it is one of your pages; a start that names an API, a file or another origin is left as written.
- **`data-sn-path` is written without the prefix** (`/article/:slug`) and matches under each language
  (`/de/article/hello`); `$url` does not include it.
- **Search engines see every language.** With `site`, each page's head has `<link rel="alternate"
  hreflang>` for each language's URL and `x-default` for its chooser, and its canonical link is its own
  language's URL.

At an unprefixed URL (`/about/`, `/article/hello`, typed, bookmarked or linked from elsewhere), the chooser
sends the visitor to a language. Without JavaScript, or on a site where no page ships any, to the base
language. On a site where pages ship JavaScript, those pages record their language in a `locale` cookie,
and the chooser follows it, else the first of the browser's languages the site has (`de-AT` is `de`), else
the base, keeping the path (`/article/hello` → `/de/article/hello`). The choosers are `noindex`. An
old file URL (`/about.html`) is a chooser too, so it reaches `/de/about/` in one hop.

The rules for hosts follow the same shape: `_redirects` has each language's rules and the choosers'.
[sinter-axum](../packages/sinter-axum/README.md) answers an unprefixed URL with a 302 to the visitor's
language itself (the cookie, else `Accept-Language`). `vite dev` serves the language pages and the
choosers as the build writes them.

A page your app links to by a URL built at run time is not rewritten into the language: use `localeUrl()`,
or build it with `$locale` (`'/' + $locale + '/task/?id=' + t.id`).


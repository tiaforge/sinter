# Images

Status: 2026-11-09. Steps 1 (static `<img>` in HTML), 1b (sizes from the page's stylesheets), 2 (images from the API) and 3 (CSS backgrounds) are implemented.

sinter optimizes the images a page uses without any markup of its own: it writes the variants at
build time and markup that lets the browser pick one. The browser knows the screen's pixel density,
the slot's width and the formats it can decode; the server does not (client hints such as
`Sec-CH-DPR` are sent by Chromium only, not by Safari on an iPad), and a static host has no server
logic at all. So nothing is negotiated per request.

- **Format**: `<picture>` with a `<source type>` per format; in CSS, `image-set()` with `type()`.
- **Density and width**: `srcset` with `w` descriptors and `sizes`.

## Sources

| Source | Handled by | Step |
| --- | --- | --- |
| `<img src="./photo.jpg">` in a page or a partial | the compiler's HTML rewrite | 1 |
| image URLs from the API (avatars, uploads): `<img data-sn-attr="{src: c.avatar}">` | a loader: dev middleware, production adapters | 2 |
| CSS `url(./hero.jpg)` | `image-set()` with `type()`, 1x and 2x | 3 |

Not planned: expanding a local image import bound in markup (`data-sn-attr="{src: photo}"`).
A page that switches between a few local images writes each as a static `<img>` under
`data-sn-if` or `data-sn-show`, so each one is optimized; a `src` bound to local image paths is
warning `SN513` saying so. Nor a `?img` import for JS: islands that
load local images are rare, have no markup or CSS to size them from, and `vite-imagetools` works
next to sinter.

A plain `import photo from './photo.jpg'` stays a URL string, as in Vite.

Left alone: remote URLs, `data:` and `blob:` URLs, SVG and GIF, an `<img>` that already has a
`srcset`, an `<img>` inside an author's `<picture>` (art direction stays hand-written), an `<img>`
with any `data-sn-*` attribute (API images: step 2), and `og:image`, favicons and touch icons (crawlers and
operating systems do not read AVIF).

## Formats

Two outputs are worth having: lossy AVIF and lossless WebP. Lossy WebP is not used: it always
halves the color resolution (4:2:0), which puts color fringes on red text, thin colored lines and
small icons, and lossy AVIF beats it on quality and size. JPEG XL is not a default while Chromium
does not ship it; it can become an opt-in `<source>` before AVIF.

The source's format says what the author meant:

| Source | Kind | `<source>` | fallback `<img>` |
| --- | --- | --- | --- |
| JPEG, lossy WebP, AVIF | photo | AVIF, 4:2:0 | JPEG (PNG with transparency) |
| PNG | graphic | lossless WebP | PNG |
| PNG that is a photo | photo | AVIF, 4:4:4 | JPEG (PNG with transparency) |

A PNG counts as a photo when its lossless WebP comes out more than twice the size of a
high-quality AVIF (measured on a copy at most 256 px wide). Exact pixels are kept wherever they
cost a reasonable size; a photo stored as PNG would not.

**Quality.** Step 1 uses fixed settings: AVIF quality 60 (photos) and 70 at 4:4:4 (graphics), JPEG
quality 82 with mozjpeg, WebP and PNG lossless. Planned: an optional perceptual metric
(SSIMULACRA2) and a search for the lowest setting that still reaches "visually lossless", so every
image looks equally good and its size is what that takes. Without the metric installed, the fixed
settings apply.

**Tiny images** (source under 4 KB) get no `<source>`: the original file, with dimensions.

## Sizes

**Fluid images.** An image without `width`/`height`, or with `width`/`height` equal to (or larger
than) its source, is fluid: `width`/`height` are only its ratio. It gets the widths 480, 960, 1440,
1920 and 2560 below the source's width, and the source's width itself. Its `sizes` is the
author's, or `auto, 100vw` for a lazy image (`auto` where the browser supports it), else `100vw`.

**Fluid images: their width at every viewport width.** The cascade (step 1b) works out how wide a
fluid image is rendered, as a function of the viewport width, and writes it as `sizes`:

```html
<img … sizes="(max-width: 479.98px) calc(100vw - 48px), (max-width: 767.98px) calc(50vw - 32px), calc(33.33vw - 26.67px)">
```

- **Ranges.** The page's width media queries (`min-width`, `max-width`, `width >= 48rem`; px, em
  and rem, which in media queries are 16 px) cut the viewport widths into ranges; in each, every
  rule either applies or does not. Other media features (`hover`, `prefers-*`, `orientation`) may
  or may not apply, as before.
- **Widths linear in the viewport.** In a range, a width is `k × 100vw + c`: `%` of a parent, `vw`,
  px and rem, margins (negative ones too), padding and borders, the browser's default margins
  (`body { margin: 8px }`, list padding). Where a `min()`, `max()`, `clamp()` or a `max-width`
  meets the viewport (a centred `max-width: 1200px` container), the range is split at the
  crossing: `(max-width: 1199.98px) calc(100vw - 32px), 1168px`.
- **Grids.** Equal tracks (`repeat(3, 1fr)`, `1fr 1fr`, `minmax(0, 1fr)`, `repeat(4, 200px)`)
  with a `gap`, an item spanning `span N` or `1 / -1`; `repeat(auto-fill, minmax(200px, 1fr))`,
  split at every viewport width where one more column fits (`auto-fit` when the items are in the
  markup, since empty tracks collapse). Unequal tracks and named areas are not resolved.
- **Flex rows.** Equal columns (every item `flex: 1` from a basis of 0, their number known: not
  rows of a `data-sn-for`), and wrapped items (`flex-wrap: wrap`) with a basis or width; a flex
  column stretches its items like a block.
- **The image.** Its own width, else its `width` attribute (sinter writes the source's), within
  its `min-width`/`max-width`: `max-width: 100%` makes it `min(source, column)`.

An image with a fixed width in every range (`40px`, `64px` from 768 px) gets exactly 1x, 2x (and
for small ones 3x) of each; otherwise widths stop at 3x of the widest it gets. Anything the engine
cannot resolve falls back to an upper bound: each container's fixed width or absolute
`max-width`, for as long as the element below cannot be wider (`(max-width: 800px) 100vw, 800px`).
An API image (step 2) uses the same. Viewports under 240 px are not split further: the first
range's condition covers them.

**Fixed boxes.** `width`/`height` smaller than the source are a display size in CSS pixels. The
image gets exactly 1x and 2x of the box, and 3x for small boxes (at most 300 × 300), each capped at
the source. `sizes` is `(max-width: <w>px) 100vw, <w>px`, so a box that CSS shrinks on a narrow
screen (`max-inline-size: 100%`) fetches less. `w` descriptors, not `1x`/`2x`: those choose by
density only, and a box shrunk on a DPR-3 phone would fetch the largest file.

Only `width` or only `height`: the other follows from the source's ratio.

## Sizes from the stylesheets (step 1b)

An image whose stylesheets give it a fixed width is a fixed box too, whatever its attributes say:
temper's avatar (`inline-size: 100%` of a `[data-avatar]` that is `calc(var(--tm-avatar-size,
2.5rem) * var(--_size, 1))` wide) is 40 px, 32 px with `data-size="sm"`, and cropped square by its
`object-fit: cover`. Nothing in the markup or in temper describes this: sinter reads the CSS the
page loads, with no knowledge of any framework (`src/compiler/layout.ts`).

**Which stylesheets.** The page's `<link rel="stylesheet">` and `<style>` elements (a `media`
attribute makes them conditional), and the stylesheets its module scripts import, following the
project modules they import and sinter's config, early, helpers and actions modules. Left out:
remote stylesheets, CSS modules and `?inline`/`?url` imports.

**As Vite outputs them, not their sources.** Sinter reads the stylesheets while it transforms the
HTML, before Vite has processed any CSS, so it compiles each one itself with Vite's
`preprocessCSS` and the project's config: Sass, Less and Stylus (with the preprocessor options),
the project's PostCSS plugins, Lightning CSS when configured, and `@import` with its `layer()` and
media. A stylesheet that does not compile (a `.scss` file without `sass` installed) is left out,
with a warning, and the build reports the error itself. Compiled stylesheets are cached until
they, or a file they read, change.

**Utility-CSS engines** (`src/engines.ts`). Some CSS does not exist yet at that point: a Vite
plugin generates it from the class names it finds, after the HTML. Replaying those plugins does
not work in general (UnoCSS's build writes a placeholder and fills it in after bundling), but
every such engine has a compiler that turns class names into CSS, and sinter has the page's
markup (with its partials). So each engine has a small adapter that asks the project's own engine,
with its installed version, config and theme, for the CSS of the classes this page uses. That is
all the cascade needs: a utility no element of the page uses matches nothing.

| Vite plugin | Stylesheet | Adapter |
| --- | --- | --- |
| Tailwind (`@tailwindcss/vite`) | a CSS file with Tailwind directives (`@import "tailwindcss"`, `@apply`, `@theme`, …) | `@tailwindcss/node`'s `compile()`, then `build()` with the page's class names |
| UnoCSS (`unocss/vite`) | `virtual:uno.css`, `uno.css`, `uno-<layer>.css` | `@unocss/config`'s `loadConfig()` and `@unocss/core`'s `generate()` with the page's markup |

The adapters are chosen by the plugins in the Vite config and load the engine from the project.
Engines that run through PostCSS (`@tailwindcss/postcss`, Tailwind 3, `@unocss/postcss`, Panda)
need none: `preprocessCSS` runs them. temper's own plugin only appends optional CSS and prunes
unused rules, which changes no size. Another engine needs an adapter of the same shape: which
stylesheet it owns, and its CSS for a page's markup. Responsive variants (`md:size-20`) are
`@media` rules, so an image with one stays fluid.

**The cascade.** Selectors (type, class, id, attribute selectors with every operator and `i`,
`:where`, `:is`, `:not`, `:root`, the structural pseudo-classes, all four combinators), nesting
(with and without `&`), `@layer` order and nesting, specificity, source order, `!important`
(reversed across layers) and inline style. Values: custom properties (inherited, with fallbacks),
`calc()`, `min()`, `max()`, `clamp()`, `px`, `rem` (from the root's font size), `%` of a parent
whose width is fixed (its content box: with `box-sizing: border-box`, less its padding and
borders, from longhands, logical properties and shorthands; a border without a style draws
nothing), `min-`/`max-` sizes and `aspect-ratio`. An image in a `<template>` has the
template's parent as its parent.

**Giving up.** A wrong size makes the image blurry; no size only costs bytes. So the image stays
fluid when its width depends on layout or might change:

- a fixed box: `%` of a fluid parent, `vw`, `em`, keywords such as `auto` or `fit-content`; the
  parent is inline or `display: contents`, a flex container with other children, or a grid with
  explicit tracks; its padding or border is in `%`, depends on a media query, or cannot be
  resolved (a fluid image's width at every viewport width resolves more of these, above);
- `em` anywhere (the font size is not followed), `vh`, `fit-content` and `max-content` widths;
- a rule that could win sits in `@supports` or `@container`, in `@media` with a feature other than
  the width, or depends on a state (`:hover`, `:has()`, `:checked`) or a selector it does not know;
- a structural selector inside a `<template>` (rows repeat);
- a binding can change what the selectors read: `data-sn-class`, `data-sn-attr` or `data-sn-model`
  (classes and attributes), `data-sn-style` (any property, custom properties included).

When the stylesheets set the width but not to a fixed size (`width: 100%`), the image is fluid
even with smaller `width`/`height` attributes: CSS decides its size, not the attributes.

A `max-width` in `%` (`max-inline-size: 100%`) only shrinks the box on narrow screens, which the
`sizes` of a box allows for; an absolute one is applied.

**Checked against Chromium.** `test/compiler/layout.test.ts` lays out every case the cascade
claims a size for, at 1600 and 390 px wide, and every fluid case at 17 viewport widths from 320 to
1920 px (both sides of each breakpoint), and compares.

**Planned:** slot widths measured in the dev server or by `temper-inspect`, for fluid images.

## Images from the API (step 2)

Most images in a sinter app come from the API: avatars, uploads, product photos, bound as
`<img data-sn-attr="{src: c.avatar}">`. They are often what a phone wrote (4000 × 3000, several
MB) and shown at 40 px. They do not exist at build time, but where they are shown does: the
binding is on an `<img>`, and the stylesheets give its box (step 1b). So the build decides the
widths, and a resizing service makes the files on request.

**Everything is a URL template.** `sinter({ images: { remote } })`:

```js
remote: {
  url: 'https://img.example.com/{w}/{url}',   // or a preset: 'cloudflare', 'vercel', 'netlify', 'imgproxy:<base URL>'
  cover: 'https://img.example.com/{w}x{h}/{url}', // optional: for a box cropped by object-fit: cover
  origins: ['self', 'https://uploads.example.com'], // the only image origins sent through it
  quality: 75,                                // {q}, default 75
}
```

| Placeholder | Value |
| --- | --- |
| `{url}` | the image's URL, percent-encoded (for a query parameter) |
| `{url:raw}` | the same, as it is (for a path) |
| `{w}`, `{h}` | the file's width and, in `cover`, height in px |
| `{q}` | `quality` |

A same-origin image (`'self'`) is passed as its path and query (`/uploads/1.jpg`), another origin's
as its absolute URL. The service picks the format from the request's `Accept` header (every one
of these does; Safari sends AVIF there too), so one URL per width is enough: no `<picture>`.

**Presets** are templates:

| Preset | `url` | `cover` |
| --- | --- | --- |
| `cloudflare` | `/cdn-cgi/image/width={w},quality={q},format=auto/{url:raw}` | `/cdn-cgi/image/width={w},height={h},fit=cover,quality={q},format=auto/{url:raw}` |
| `vercel` | `/_vercel/image?url={url}&w={w}&q={q}` | none (Vercel resizes by width only) |
| `netlify` | `/.netlify/images?url={url}&w={w}&q={q}` | `/.netlify/images?url={url}&w={w}&h={h}&fit=cover&q={q}` |
| `imgproxy:<base>` | `<base>/insecure/rs:fit:{w}:0/q:{q}/plain/{url}` | `<base>/insecure/rs:fill:{w}:{h}/q:{q}/plain/{url}` |

Each service has its own allowlist of source origins (Cloudflare's zone settings, Vercel's
`images.domains` and `images.sizes`, Netlify's `remote_images`, imgproxy's
`IMGPROXY_ALLOWED_SOURCES`) and must have it: URLs are built in the browser, so they cannot be
signed with a secret (imgproxy runs unsigned, `insecure`). imgproxy fetches every source itself,
so a same-origin path needs its `IMGPROXY_BASE_URL`.

**What the compiler writes.** An `<img>` whose `data-sn-attr` binds `src` to data (a resource, an
item of one, a helper reading them; not a constant or state) gets a `srcset` binding next to the
`src` binding, both from the same value, through `@tiaforge-ui/sinter/remote` (about 0.5 KB gzip,
only in pages that have such images). Every row of a `data-sn-for` counts as data. Its box is the one the stylesheets give it (step 1b):

- a fixed box: 1x, 2x and (up to 300 × 300) 3x of its width, `sizes` of the box, `width`/`height`;
  cropped with `cover` when the stylesheets say `object-fit: cover` and `cover` is set (else
  resized to the width only: the dev check warns if that leaves too few rows);
- otherwise fluid: the fluid widths, `sizes="auto, 100vw"`.

`src` is the 1x file (fluid: 1280 px). `decoding="async"`; `loading="lazy"` in rows and on fluid
images (their `sizes="auto"` needs it), not on a fixed box outside a template, which may be the
page's largest image. An author's `sizes`, `loading`, `width` or `height` wins. A bound `srcset`,
an `<img>` in a `<picture>` or a static `srcset` is left alone.

**Vercel** resizes only the widths listed in `vercel.json` (`images.sizes`); a build with the
`vercel` preset prints the widths its pages use.

**At runtime**, a URL whose origin is not in `origins`, that is not http(s), or that ends in `.svg`
or `.gif`, is written as it is, with no `srcset`: no other origin is ever sent through the
service. A `null` value removes both, as before.

**Dev.** No service resizes `localhost`, so the dev server does: the same bindings use
`/@sinter/remote?url=…&w=…&h=…&q=…`, which fetches the source (only from `origins`, and the dev
server itself for `'self'`, through its proxy), resizes it with sharp, picks AVIF, WebP or JPEG/PNG
from `Accept`, and keeps it in memory. Without `remote`, API images are left as written, in dev and
in builds alike, so dev does not hide what production does.

## CSS backgrounds (step 3)

`background` and `background-image` with `url()` of a local JPEG, PNG, WebP or AVIF get
`image-set()`, as a second declaration after the original, which stays for browsers without
`image-set()` types:

```css
.hero { background: url(/assets/hero-….jpg) 50%/cover;
        background: image-set(url("…hero-800….avif") type("image/avif") 1x, url("…hero-1600….avif") type("image/avif") 2x,
                              url("…hero-800….jpg") type("image/jpeg") 1x, url("…hero-1600….jpg") type("image/jpeg") 2x) 50%/cover }
```

- **Formats** as for `<img>`: AVIF for photos, lossless WebP for graphics, JPEG or PNG as the fallback;
  files under 4 KB are left alone (Vite inlines them anyway).
- **The source counts as 2x** when the rule sizes the background (`background-size` other than
  `auto`, or a size in the shorthand: `center / cover`): a 1600 px source gives 800 px for 1x
  screens and 1600 px for 2x. A rule that does not size it gets one file per format at 1x: a 2x
  file would halve the image's intrinsic size, and so the size of a tile or of an unscaled image.
- **Where**: dev rewrites each stylesheet after Vite's CSS compiler (Sass, Less, Stylus and PostCSS
  have run, `url()`s point at their files); builds rewrite the finished stylesheets, whose `url()`s
  name the build's copies of the images. So `url()`s in Sass partials work too.
- **Left alone**: other properties (`mask`, `border-image`, `content`, `@font-face`), remote and
  `data:` URLs, files in `public/`, declarations that already use `image-set()`, `?inline` and
  `?url` imports, inline `style` attributes, and CSS a utility engine generates.
- A background whose element is larger at 1x than half the source is soft on 1x screens: use a
  source twice the largest width it is shown at. The dev console warns when that happens.

## Cropping

A crop is written in plain HTML and CSS, and replaced by HTML for the cropped file:

```html
<img src="photo.jpg" width="200" height="200" style="object-fit: cover; object-position: 30% 20%" alt="…">
```

The build crops to the box's ratio at `object-position` (default the center), makes the exact
sizes, and removes `object-fit` and `object-position` from `style`, since the file now has the
box's ratio; an empty `style` is removed. The output has no `style`, so a strict
Content-Security-Policy holds.

| `object-fit` | Build |
| --- | --- |
| `cover` | crops |
| `contain` | no crop; exact sizes of the area the image takes inside the box |
| none or `fill`, ratio differs | warning `SN512`: the image is stretched |
| `none`, `scale-down` | left alone |

`object-fit` and `object-position` come from the cascade: the inline style, or a stylesheet rule
when the box comes from the stylesheets (step 1b), as with temper's avatar. Only an inline style is
removed; a stylesheet's `cover` does nothing on a file that has the box's ratio. A crop whose ratio
changes with a media query needs `<picture>` with `media`, written by hand.

## Loading and layout

- `width` and `height` are always set (the box, or the source's dimensions), so the box has its
  size before the image arrives.
- `decoding="async"`. `loading="lazy"` on every image except the first one outside a
  `<template>` in the page; an author's `loading` wins.
- A generated stylesheet, imported by the page module (so Vite puts it in the page's CSS: no
  extra request, no inline `style`), gives each rewritten image `height: auto` (its file has the
  ratio of its `width`/`height`, so this only keeps it from being squashed when CSS narrows it)
  and, for an opaque image, its dominant color as `background-color`: the box shows that color
  until the image covers it. Selectors are `:where(img[src="…"])`, so any rule of the app wins.
- The variants' URLs carry `vite-ignore`, so Vite's HTML processing leaves them alone.

## Warnings

- `SN511 image-too-small`: a fixed box needs more pixels than the source has at 2x. The source is
  used as the largest file; the fix is a larger source.
- `SN512 image-stretched`: the box (`width`/`height`, or the stylesheets) has another ratio than
  the source and no `object-fit`. Add `object-fit: cover` to crop, or fix the attributes.

**In the browser, in dev.** The dev server adds a script to every page (`src/image-check.ts`;
builds never include it). When an image has loaded, and after a resize, it compares the pixels of
the file the browser chose with the device pixels the image covers (with `object-fit: cover`, the
larger side), and warns in the console when the file has less than 90% of them: either the
source is too small, or a larger file exists and `sizes` is smaller than the image is shown. It
checks every `<img>`, rewritten or not, at the screen it runs on: open the dev server on an iPad to
check an iPad. CSS backgrounds too: for each element with a background image (and again when
elements are added, or a `class` or `style` changes), the file the browser uses (a `url()`, or the
`image-set()` option of a decoded type at the resolution nearest at or above the screen's), drawn
at the width `background-size` gives it in the positioning area (`cover`, `contain`, lengths, `%`,
or `auto`: the file's size at its resolution). For an `image-set()` the message says the build
counts the source as 2x and names the width it needs. `::before` and `::after` are checked at
their computed size (when they are drawn: `content` set, a size in px).

**Planned in `temper-inspect`:** the same comparison at device scale factor 2 for pages without
sinter.

- `SN513 bound-local-image`: an `<img>` binds `src` to a local image path, or chooses between a
  few (`dark ? './logo-dark.png' : './logo.png'`), which the build cannot optimize. Write each as a
  static `<img>` under `data-sn-if` or `data-sn-show`.

## Build and dev

- **Analysis** (sharp): dimensions after EXIF orientation, transparency, dominant color, kind.
  Cached by content hash in `node_modules/.cache/sinter/images`.
- **Dev**: the page links `/@sinter/img/<file>`; the dev server encodes a variant the first time
  it is requested (AVIF at a lower effort) and caches it.
- **Build**: the same names under `assets/`, encoded in parallel, reused from the cache. With a
  relative `base` (`./`), URLs are relative to the page (`../assets/…` from `blog/post.html`) and to
  the stylesheet, as Vite writes its own.
- sharp is an optional dependency: installed by default; without it, images are left as written
  and the build says so once.
- `sinter({ images: false })` turns it off; `images: { widths: [...] }` sets the fluid widths.

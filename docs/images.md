# Images

sinter optimizes the images your pages use without extra markup. At build time it writes AVIF, WebP
and JPEG/PNG variants and rewrites the element so the browser picks the right format and width
(`<picture>`, `srcset`, `sizes`). Nothing is negotiated per request, so it works on a static host.

```js
// vite.config.js
sinter({ images: { widths: [480, 960, 1920] } })  // optional
sinter({ images: false })                         // turn image handling off
```

## What is optimized

| Source | What you write | Result |
| --- | --- | --- |
| Local image in a page or component | `<img src="./photo.jpg" alt="...">` | `<picture>` with format sources, `srcset`, `sizes`, `width`, `height` |
| Image URL from your API | `<img data-sn-attr="{src: c.avatar}">` | `srcset` pointing at a [resizing service](#images-from-the-api) |
| CSS background | `background: url(./hero.jpg)` | [`image-set()`](#css-backgrounds) with AVIF and a fallback |

A plain `import photo from './photo.jpg'` in JavaScript stays a URL string, as in Vite.

Left alone: remote, `data:` and `blob:` URLs, SVG and GIF, an `<img>` that already has a `srcset`,
an `<img>` inside your own `<picture>` (art direction stays hand-written), an `<img>` with
`data-sn-*` attributes (those are API images), and `og:image`, favicons and touch icons.

A page that switches between a few local images writes each as a static `<img>` under `data-sn-if`
or `data-sn-show`, so each is optimized. A `src` bound to local image paths is warning
[`SN513`](#warnings).

## Formats

| Source | Treated as | `<source>` | Fallback `<img>` |
| --- | --- | --- | --- |
| JPEG, lossy WebP, AVIF | photo | AVIF, 4:2:0 | JPEG (PNG with transparency) |
| PNG | graphic | lossless WebP | PNG |
| PNG that is a photo | photo | AVIF, 4:4:4 | JPEG (PNG with transparency) |

A PNG counts as a photo when its lossless WebP is more than twice the size of a high-quality AVIF.
Lossy WebP is not used: it halves color resolution, which fringes red text and thin colored lines.

Quality is fixed: AVIF 60 (photos) and 70 at 4:4:4 (graphics), JPEG 82 with mozjpeg, lossless WebP
and PNG. Images under 4 KB get no `<source>`: the original file, with dimensions.

## Sizes

Write `width` and `height` the way you would anyway. sinter works out which of two cases applies.

**Fixed box.** `width`/`height` smaller than the source are a display size in CSS pixels. The image
gets 1x and 2x of the box (3x for boxes up to 300 x 300), each capped at the source size, and
`sizes` is `(max-width: <w>px) 100vw, <w>px`, so a box that CSS shrinks on a narrow screen fetches
less. With only `width` or only `height`, the other follows from the source's ratio.

```html
<img src="./avatar.jpg" width="48" height="48" alt="...">
```

**Fluid image.** No `width`/`height`, or ones equal to or larger than the source: they only give
the ratio. The image gets the widths 480, 960, 1440, 1920 and 2560 below the source's width, plus
the source's own width. `sizes` is yours if you wrote one, otherwise `auto, 100vw` for a lazy image
(`auto` where the browser supports it) and `100vw` for the rest.

### How the rendered width is worked out

sinter reads the CSS your page loads and computes how wide each image is drawn, then writes that
into `sizes`. For a fluid image, it does this at every viewport width:

```html
<img ... sizes="(max-width: 479.98px) calc(100vw - 48px), (max-width: 767.98px) calc(50vw - 32px), calc(33.33vw - 26.67px)">
```

It follows your width media queries (`min-width`, `max-width`, `width >= 48rem`), percentages,
`vw`, px, rem and em, margins, padding, borders, `min()`, `max()`, `clamp()`, `max-width`, custom
properties, and `aspect-ratio`. It resolves grids with fixed and `fr` tracks, equal or not
(`repeat(3, 1fr)`, `240px 1fr`, `2fr 1fr`, `minmax(200px, 1fr) 300px`, `repeat(auto-fill, minmax(200px, 1fr))`, spans, lines
such as `2 / -1`, `gap`; a column with a minimum is held at it where its share is smaller, as the
browser does), named areas (`grid-template-areas` with `grid-area: main`), and flex rows
whose items have a known size or grow from one: equal columns, a fixed sidebar beside a `flex: 1`
main column, an avatar beside a growing body, wrapped items. When grid tracks differ, the column an
auto-placed item lands in follows the items before it. An image with a fixed width at every
viewport gets exactly 1x and 2x (3x for small ones); otherwise widths stop at 3x of the widest it
can be.

```css
body { margin: 0 }
.layout { display: grid; gap: 24px }
@media (min-width: 768px) { .layout { grid-template-columns: 240px 1fr } }
.layout img { width: 100% }
/* an image in the second column: sizes="(max-width: 767.98px) 100vw, calc(100vw - 264px)" */
```

**At every default font size.** Visitors can change the browser's default font size (16 px unless
they do; Chrome and Firefox offer 20 and 24 px as "large" and "very large"), and every `rem`, `em`
and `em` breakpoint grows with it. `sizes` reads `em` the same way, as the default font size
whatever the page's root size, so sinter solves each image at 16, 24 and 12 px and writes what
depends on the font size in `em`:

```html
<!-- body { margin: 0 } .prose { font-size: 1.125rem; max-width: 40em; padding: 0 1em; margin: 0 auto } -->
<img ... sizes="(max-width: 47.2475em) calc(100vw - 2.25em), 45em">
```

A range's end that mixes px and em (a `60rem` column inside the body's 8 px margins) is where two
widths cross, written as `min()` or `max()` of them, followed by the same range in px for
browsers that do not read math functions in `sizes`. Fixed boxes in rem (Tailwind's `size-12`) get
`sizes` in em and one more file, the 2x of the box at a 24 px default. When the solutions do not line up
(a `rem` width crossing a px breakpoint at some font sizes and not others), `sizes` is the 16 px
one, as before. Checked in Chromium at 12, 16, 20 and 24 px.

**Which CSS is read.** The page's `<link rel="stylesheet">` and `<style>` elements, and
stylesheets imported by its module scripts. Remote stylesheets, CSS modules and `?inline`/`?url`
imports are left out. Stylesheets are compiled with your Vite config first (Sass, Less, Stylus,
PostCSS, Lightning CSS), so what sinter reads is what ships. A stylesheet that does not compile
is skipped with a warning, and the build reports the error itself.

**Tailwind and UnoCSS.** Both are supported: sinter asks the project's own engine for the CSS of
the classes the page uses. Engines that run through PostCSS need nothing extra. Responsive
variants (`md:size-20`) are `@media` rules, so an image with one stays fluid.

### When it falls back to fluid

A wrong size makes an image blurry, while no size only costs bytes, so sinter stays fluid whenever
a width depends on layout it cannot predict:

- widths in `vh`, `fit-content`, `max-content` or `auto`, or a `%` of a fluid parent; `ch` anywhere
  but a box's own `width` or `max-width` (see below);
- `em` where the font size is not fixed: in `vw`, changed by a state or a media feature other than
  width, or under a lone `monospace` font (browsers scale its default size);
- a parent that is inline or `display: contents`, a flex row with an item sized by its content (a
  label without a width) or that overflows the row, or a grid with `auto`, `fit-content()` or `minmax()` tracks of two lengths (`minmax(200px, 1fr)` is followed);
- unequal grid tracks with an item flowing by column (`grid-auto-flow: column`);
- a rule that could win sits in `@supports` or `@container`, in `@media` with a feature other than
  width, or depends on state (`:hover`, `:has()`, `:checked`);
- a structural selector inside a `<template>`, where rows repeat;
- the image or its ancestors use `data-sn-class`, `data-sn-attr`, `data-sn-model` or
  `data-sn-style`, which can change what the selectors read.

When the stylesheets set `width: 100%`, the image is fluid even with smaller `width`/`height`
attributes: CSS decides, not the attributes.

**Only where it is needed.** The fallback applies per range of viewport widths: a layout that
cannot be followed on phones (a label sized by its text beside the image) but can from a breakpoint
up keeps exact widths there, and so does a fixed sidebar that leaves no room on the narrowest
screens. In a range that cannot be followed, the width is bounded by the containers there (a
`max-width: 500px` column), else by the viewport. Only when no range can be followed does `sizes`
fall back to one upper bound such as `(max-width: 800px) 100vw, 800px`.

**Measures in `ch`.** A column such as `.prose { max-width: 65ch }` bounds the images in it. How
wide `1ch` is depends on the font that renders the text, which differs by platform, by the
visitor's settings, and while a web font loads, so sinter counts it as at most `0.7em`, wider than
any common text font's `0` (Arial 0.556, DejaVu 0.636). A web font whose `0` is wider raises that,
read from its file (TTF, OTF, WOFF, WOFF2); one whose file cannot be read leaves the column
unbounded. `ch` is followed only in a box's `width` and `max-width`, where a wider box can only
make the image wider: in a margin, a padding, a sibling's width or a grid track, more could mean
narrower, and it is not followed.

**Rows in unequal tracks.** When an auto-placed item's column is not known, because it is a row of
a `data-sn-for` (each row lands in the next column) or an item before it is placed by its row or
reordered, it gets the widest column it can land in: in `grid-template-columns: 1fr 2fr` with a
30 px gap, `calc(66.67vw - 20px)` for every row. The narrow column's rows fetch a larger file than
they need, never a smaller one. Images in the rows of a
`data-sn-for` inside a `repeat(auto-fit, ...)` grid get the upper bound too ([`SN514`](#warnings)).

## Images from the API

Avatars and uploads often arrive as 4000 x 3000 phone photos shown at 40 px. They do not exist at
build time, but the `<img>` that shows them does, and the stylesheets give its box. So the build
decides the widths and a resizing service produces the files on request.

Configure one URL template:

```js
sinter({
  images: {
    remote: {
      url: 'https://img.example.com/{w}/{url}',  // or a preset, see below
      cover: 'https://img.example.com/{w}x{h}/{url}', // optional: for object-fit: cover boxes
      origins: ['self', 'https://uploads.example.com'], // the only origins sent through it
      quality: 75,                                // {q}, default 75
    },
  },
})
```

| Placeholder | Value |
| --- | --- |
| `{url}` | the image URL, percent-encoded (for a query parameter) |
| `{url:raw}` | the same, as is (for a path) |
| `{w}`, `{h}` | the file's width and, in `cover`, height in px |
| `{q}` | `quality` |

A same-origin image (`'self'`) is passed as its path and query (`/uploads/1.jpg`), another
origin's as its absolute URL. The service picks the format from the `Accept` header, so one URL
per width is enough and there is no `<picture>`.

**Presets** for `url`:

| Preset | `url` | `cover` |
| --- | --- | --- |
| `cloudflare` | `/cdn-cgi/image/width={w},quality={q},format=auto/{url:raw}` | `/cdn-cgi/image/width={w},height={h},fit=cover,quality={q},format=auto/{url:raw}` |
| `vercel` | `/_vercel/image?url={url}&w={w}&q={q}` | none (Vercel resizes by width only) |
| `netlify` | `/.netlify/images?url={url}&w={w}&q={q}` | `/.netlify/images?url={url}&w={w}&h={h}&fit=cover&q={q}` |
| `imgproxy:<base URL>` | `<base>/insecure/rs:fit:{w}:0/q:{q}/plain/{url}` | `<base>/insecure/rs:fill:{w}:{h}/q:{q}/plain/{url}` |

Configure each service's allowlist of source origins (Cloudflare's zone settings, Vercel's
`images.domains` and `images.sizes`, Netlify's `remote_images`, imgproxy's
`IMGPROXY_ALLOWED_SOURCES`). It is required: URLs are built in the browser, so they cannot be
signed (imgproxy runs unsigned, `insecure`). imgproxy fetches every source itself, so a
same-origin path needs its `IMGPROXY_BASE_URL`. Vercel only resizes the widths listed in
`vercel.json` (`images.sizes`); a build with the `vercel` preset prints the widths your pages use.

**What gets a `srcset`.** An `<img>` whose `data-sn-attr` binds `src` to data (a resource, an item
of one, or a helper reading them; not a constant or state) gets a `srcset` binding next to `src`.
Every row of a `data-sn-for` counts as data. This adds about 0.5 KB gzip, only on pages that have
such images.

- Fixed box: 1x, 2x and (up to 300 x 300) 3x of its width, `sizes` of the box, `width`/`height`.
  With `object-fit: cover` in the CSS and `cover` set, the file is cropped; without `cover` it is
  resized by width only, and the dev check warns if that leaves too few rows.
- Otherwise fluid: the fluid widths and `sizes="auto, 100vw"`.

`src` is the 1x file (1280 px for fluid). `decoding="async"` is set; `loading="lazy"` is set in
rows and on fluid images, but not on a fixed box outside a template, which may be the page's
largest image. Your own `sizes`, `loading`, `width` or `height` win. A bound `srcset`, an `<img>`
in a `<picture>` or a static `srcset` is left alone.

**At runtime**, a URL whose origin is not in `origins`, that is not http(s), or that ends in
`.svg` or `.gif` is written as is, with no `srcset`. No other origin is ever sent through the
service. A `null` value removes both attributes.

**In dev**, no service can resize `localhost`, so the dev server does: the bindings use
`/@sinter/remote?url=...&w=...&h=...&q=...`, which fetches the source (only from `origins`),
resizes it with sharp, picks AVIF, WebP or JPEG/PNG from `Accept` and keeps it in memory. Without
`remote`, API images are left as written in dev and in builds alike, so dev shows what production
does.

## CSS backgrounds

`background` and `background-image` with `url()` of a local JPEG, PNG, WebP or AVIF get an
`image-set()` as a second declaration after the original. The original stays for browsers that do
not support `image-set()` types:

```css
.hero { background: url(/assets/hero-....jpg) 50%/cover;
        background: image-set(url("...hero-800....avif") type("image/avif") 1x, url("...hero-1600....avif") type("image/avif") 2x,
                              url("...hero-800....jpg") type("image/jpeg") 1x, url("...hero-1600....jpg") type("image/jpeg") 2x) 50%/cover }
```

- Formats are as for `<img>`. Files under 4 KB are left alone (Vite inlines them anyway).
- **The source counts as 2x** when the rule sizes the background (`background-size` other than
  `auto`, or a size in the shorthand such as `center / cover`): a 1600 px source gives 800 px for
  1x screens and 1600 px for 2x. A rule that does not size it gets one file per format at 1x.
- A background whose element is larger at 1x than half the source looks soft on 1x screens. Use a
  source twice the largest width it is shown at; the dev console warns about this.
- `url()`s in Sass, Less, Stylus and PostCSS partials work.
- Left alone: other properties (`mask`, `border-image`, `content`, `@font-face`), remote and
  `data:` URLs, files in `public/`, declarations that already use `image-set()`, `?inline` and
  `?url` imports, inline `style` attributes, and CSS generated by a utility engine.

## Cropping

Write the crop in plain HTML and CSS:

```html
<img src="photo.jpg" width="200" height="200" style="object-fit: cover; object-position: 30% 20%" alt="...">
```

The build crops to the box's ratio at `object-position` (default center), makes the exact sizes,
and removes `object-fit` and `object-position` from `style` (an empty `style` is removed). The
output has no `style`, so a strict Content-Security-Policy holds.

| `object-fit` | Build |
| --- | --- |
| `cover` | crops |
| `contain` | no crop; exact sizes of the area the image takes inside the box |
| none or `fill`, ratio differs | warning `SN512`: the image is stretched |
| `none`, `scale-down` | left alone |

`object-fit` and `object-position` come from the inline style or, when the box comes from the
stylesheets, from a stylesheet rule. Only an inline style is removed; a stylesheet's `cover` does
nothing on a file that already has the box's ratio. A crop whose ratio changes with a media query
needs a hand-written `<picture>` with `media`.

## Loading and layout

- `width` and `height` are always set (the box, or the source's dimensions), so the box has its
  size before the image arrives.
- `decoding="async"`. `loading="lazy"` on every image except the first one outside a `<template>`
  on the page. Your own `loading` wins.
- A generated stylesheet, imported by the page module (no extra request, no inline `style`), gives
  each rewritten image `height: auto` and, for an opaque image, its dominant color as
  `background-color` until the image covers it. The selectors are `:where(img[src="..."])`, so any
  rule of yours wins.

## Warnings

| Code | Meaning | Fix |
| --- | --- | --- |
| `SN511 image-too-small` | A fixed box needs more pixels than the source has at 2x. The source is used as the largest file. | Use a larger source. |
| `SN512 image-stretched` | The box (`width`/`height`, or the stylesheets) has another ratio than the source and no `object-fit`. | Add `object-fit: cover` to crop, or fix the attributes. |
| `SN513 bound-local-image` | An `<img>` binds `src` to a local image path, or chooses between a few (`dark ? './logo-dark.png' : './logo.png'`), which the build cannot optimize. | Write each as a static `<img>` under `data-sn-if` or `data-sn-show`. |
| `SN514 auto-fit-rows` | An image in the rows of a `data-sn-for` inside a `repeat(auto-fit, ...)` grid. Its width depends on the row count, known only at runtime, so it gets the upper bound. | Use `auto-fill` (the same columns, without stretching a short list), or write `sizes`. |

**Check in the browser, in dev.** The dev server adds a script to every page (builds never include
it). Once an image has loaded, and after a resize, it compares the pixels of the file the browser
chose with the device pixels the image covers (with `object-fit: cover`, the larger side). It warns
in the console when the file has less than 90% of them: either the source is too small, or a
larger file exists and `sizes` is smaller than the image is shown. It checks every `<img>`,
rewritten or not, at the screen it runs on, so open the dev server on an iPad to check an iPad.

It checks CSS backgrounds too (including `::before` and `::after` when drawn at a px size). For an
`image-set()`, the message says the build counts the source as 2x and names the width it needs.

## Build and dev

- **Analysis** (sharp): dimensions after EXIF orientation, transparency, dominant color and kind,
  cached by content hash in `node_modules/.cache/sinter/images`.
- **Dev**: the page links `/@sinter/img/<file>`. The dev server encodes a variant the first time
  it is requested (AVIF at a lower effort) and caches it.
- **Build**: the same names under `assets/`, encoded in parallel and reused from the cache. With
  a relative `base` (`./`), URLs are relative to the page (`../assets/...` from `blog/post.html`)
  and to the stylesheet, as Vite writes its own.
- **sharp** is an optional dependency, installed by default. Without it, images are left as
  written and the build says so once.

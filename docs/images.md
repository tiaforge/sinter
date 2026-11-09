# Images

Status: 2026-11-09. Step 1 (static `<img>` in HTML) is implemented; the later steps are planned.

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
| an image import bound in markup: `<img data-sn-attr="{src: photo}">` | the compiler expands the binding | 2 |
| `import photo from './photo.jpg?img'` in plain JS | `{ src, srcset, sources, width, height }` | 2 |
| CSS `url(./hero.jpg)` | `image-set()` with `type()`, 1x and 2x | 3 |
| image URLs from the API (avatars, uploads) | a loader: dev middleware, production adapters | 5 |

A plain `import photo from './photo.jpg'` stays a URL string, as in Vite.

Left alone: remote URLs, `data:` and `blob:` URLs, SVG and GIF, an `<img>` that already has a
`srcset`, an `<img>` inside an author's `<picture>` (art direction stays hand-written), an `<img>`
with any `data-sn-*` attribute (step 2), and `og:image`, favicons and touch icons (crawlers and
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

**Fixed boxes.** `width`/`height` smaller than the source are a display size in CSS pixels. The
image gets exactly 1x and 2x of the box, and 3x for small boxes (at most 300 × 300), each capped at
the source. `sizes` is `(max-width: <w>px) 100vw, <w>px`, so a box that CSS shrinks on a narrow
screen (`max-inline-size: 100%`) fetches less. `w` descriptors, not `1x`/`2x`: those choose by
density only, and a box shrunk on a DPR-3 phone would fetch the largest file.

Only `width` or only `height`: the other follows from the source's ratio.

**Planned sources of exact sizes:** temper components with a known size (avatar sizes from
temper's `vocab.json`), fixed px/rem widths in CSS, and slot widths measured by `temper-inspect`.

## Cropping

A crop is written in plain HTML and CSS, and replaced by HTML for the cropped file:

```html
<img src="photo.jpg" width="200" height="200" style="object-fit: cover; object-position: 30% 20%" alt="…">
```

The build crops to the box's ratio at `object-position` (default the center), makes the exact
sizes, and removes `object-fit` and `object-position` from `style`, since the file now has the
box's ratio; an empty `style` is removed. The output has no `style`, so a strict
Content-Security-Policy holds.

| `object-fit` (inline) | Build |
| --- | --- |
| `cover` | crops |
| `contain` | no crop; exact sizes of the area the image takes inside the box |
| none or `fill`, ratio differs | warning `SN512`: the image is stretched |
| `none`, `scale-down` | left alone |

`object-fit` from a stylesheet is not read: the compiler cannot tell which rules reach an element.
A crop whose ratio changes with a media query needs `<picture>` with `media`, written by hand.

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
- `SN512 image-stretched`: `width`/`height` have another ratio than the source and no inline
  `object-fit`. Add `object-fit: cover` to crop, or fix the attributes.

**Planned in `temper-inspect`:** a pass at device scale factor 2 that compares, for every
`<img>`, `naturalWidth` of its `currentSrc` with `clientWidth × 2`, and for backgrounds the image's
size with the rendered `background-size`: a file that is too small for the slot, or a `sizes`
that made the browser pick one that is too small.

## Build and dev

- **Analysis** (sharp): dimensions after EXIF orientation, transparency, dominant color, kind.
  Cached by content hash in `node_modules/.cache/sinter/images`.
- **Dev**: the page links `/@sinter/img/<file>`; the dev server encodes a variant the first time
  it is requested (AVIF at a lower effort) and caches it.
- **Build**: the same names under `assets/`, encoded in parallel, reused from the cache.
- sharp is an optional dependency: installed by default; without it, images are left as written
  and the build says so once.
- `sinter({ images: false })` turns it off; `images: { widths: [...] }` sets the fluid widths.

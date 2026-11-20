# sinter logo

The mark is a JSON brace and an HTML bracket with data streaming between them: the earlier grains
grey, the newest one coral. It is what sinter does, JSON from your API becoming a live HTML page.

| File | Use it for |
| --- | --- |
| `sinter-logo.svg` | The logo on light backgrounds (README, docs header) |
| `sinter-logo-dark.svg` | The logo on dark backgrounds |
| `sinter-logo-stacked.svg` | Square-ish spaces: title slides, social cards |
| `sinter-logo-stacked-dark.svg` | The same on dark backgrounds |
| `sinter-mark.svg` | The mark alone, on light backgrounds |
| `sinter-mark-dark.svg` | The mark alone, on dark backgrounds |
| `sinter-icon.svg` | Square crops: favicon, avatar, app icon |

To switch with the reader's colour scheme, as the repository README does:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo/sinter-logo-dark.svg">
  <img src="docs/logo/sinter-logo.svg" alt="sinter" width="240" height="54">
</picture>
```

## Colours

| | Light backgrounds | Dark backgrounds |
| --- | --- | --- |
| Ink (brackets, wordmark) | `#0b1f2a` | `#f4f7f6` |
| Earlier grains | `#8796a0` | `#7d8f99` |
| Newest grain | `#e8553a` | `#ff8a5c` |

The icon's tile is `#0b1f2a`. The navy, the off-white and the single coral highlight are shared
with the other tiaforge projects.

## Rules

- Keep exactly one coral element: the newest grain. The wordmark has none.
- In the lockups the mark has no tile; it is centred on the lowercase letters, not on the full word
  height. Use the tile only where the space is a square.
- Leave clear space around the logo of at least the height of the wordmark's lowercase letters.
- Do not redraw the wordmark in a font: it is drawn to match the lettering of the other tiaforge
  projects.

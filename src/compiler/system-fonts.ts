// `line-height: normal` of the fonts browsers have without downloading them, as a multiple of the
// font size: (ascent + descent) / unitsPerEm, line gaps left out, as font-metrics.ts reads a font
// file. A page's text is in one of these until its web font has loaded (`font-display: swap`), and
// for good where it names them or a generic family. Values from @capsizecss/metrics 4.4.0 (MIT,
// Copyright (c) 2021 SEEK), and for DejaVu read from its files (font-metrics.ts); Liberation's
// files match Arial's, Times New Roman's and Courier New's below.

/** by family, lower case */
export const SYSTEM_FONTS: Record<string, number> = {
  'arial': (1854 + 434) / 2048,
  'helvetica': (1577 + 471) / 2048,
  'helvetica neue': (952 + 213) / 1000,
  // San Francisco, as `-apple-system`, `BlinkMacSystemFont` and `system-ui` name it on Apple platforms
  '-apple-system': (1980 + 432) / 2048,
  'blinkmacsystemfont': (1980 + 432) / 2048,
  'segoe ui': (2210 + 514) / 2048,
  'roboto': (1900 + 500) / 2048,
  'times new roman': (1825 + 443) / 2048,
  'georgia': (1878 + 449) / 2048,
  'courier new': (1705 + 615) / 2048,
  'tahoma': (2049 + 423) / 2048,
  'verdana': (2059 + 430) / 2048,
  'noto sans': (1069 + 293) / 1000,
  'noto serif': (1069 + 293) / 1000,
  'noto sans mono': (1069 + 293) / 1000,
  'roboto mono': (2146 + 555) / 2048,
  'cantarell': (2240 + 660) / 2048,
  'ubuntu': (932 + 189) / 1000,
  'oxygen': (2103 + 483) / 2048,
  'dejavu sans': (1901 + 483) / 2048,
  'dejavu serif': (1901 + 483) / 2048,
  'dejavu sans mono': (1901 + 483) / 2048,
  'liberation sans': (1854 + 434) / 2048,
  'liberation serif': (1825 + 443) / 2048,
  'liberation mono': (1705 + 615) / 2048,
};

/**
 * What a generic family is on each platform the browsers' defaults pick from (Windows, macOS and iOS,
 * Android, Linux): its `normal` is the least of them. A default without metrics here (Times, Menlo,
 * Consolas on their platforms) counts as 1, below their published values. A page that names no font
 * gets the browser's default, `serif`.
 */
export const GENERIC_FONTS: Record<string, Array<string | 1>> = {
  'sans-serif': ['arial', 'helvetica', 'roboto', 'dejavu sans', 'liberation sans', 'noto sans'],
  'serif': ['times new roman', 1, 'noto serif', 'dejavu serif', 'liberation serif'],
  'monospace': [1, 'courier new', 'roboto mono', 'dejavu sans mono', 'liberation mono', 'noto sans mono'],
  'system-ui': ['segoe ui', '-apple-system', 'roboto', 'cantarell', 'ubuntu', 'dejavu sans', 'noto sans'],
  'ui-sans-serif': ['segoe ui', '-apple-system', 'roboto', 'cantarell', 'ubuntu', 'dejavu sans', 'noto sans'],
  'ui-serif': ['times new roman', 1, 'noto serif', 'dejavu serif'],
  'ui-monospace': [1, 'courier new', 'roboto mono', 'dejavu sans mono'],
  'ui-rounded': ['segoe ui', '-apple-system', 'roboto'],
  'cursive': [1],
  'fantasy': [1],
  'math': [1],
  'emoji': [1],
  'fangsong': [1],
};

/** The least `normal` of a generic family across platforms. */
export const genericNormal = (name: string): number | null => {
  const list = GENERIC_FONTS[name];
  return list ? Math.min(...list.map((x) => (x === 1 ? 1 : SYSTEM_FONTS[x]!))) : null;
};

/**
 * `1ch` (the advance of `0`) at most, as a multiple of the font size, for any font the browser has
 * without downloading it: above every text font measured in Chromium (Arial, Helvetica and Times
 * through their metric clones 0.556 and 0.5, Courier New 0.6, Calibri 0.507, Cambria 0.517,
 * DejaVu Sans and Serif 0.636, DejaVu Sans Mono 0.602). A stack always ends in a generic family or
 * the browser's default, which differ by platform and by the visitor's settings, so no stack is
 * known more closely than this; a web font whose `0` is wider (read from its file) raises it.
 */
export const UNKNOWN_ZERO = 0.7;

// @vitest-environment node
// Font preloads (fonts-build.ts, `sinter({ fonts: { preload } })`): which file a face preloads, and
// whether a stylesheet uses a family (the build fails for a preloaded family no stylesheet uses).
import { expect, test } from 'vitest';
import { faceName, faceOf, fontFaceUrl, fontPreloadTag, preloadLocalFonts, usesFamily } from '../../src/fonts-build.js';

const face = (subset: string, family: string, weight: number, style: string, file: string, range = 'U+0000-00FF') =>
  `/* ${subset} */\n@font-face {\n  font-family: '${family}';\n  font-style: ${style};\n  font-weight: ${weight};\n  src: url(https://fonts.gstatic.com/s/${file}.woff2) format('woff2');\n  unicode-range: ${range};\n}\n`;
const GOOGLE = face('cyrillic', 'Source Sans Pro', 400, 'normal', 'ssp-cyr', 'U+0400-045F')
  + face('latin-ext', 'Source Sans Pro', 400, 'normal', 'ssp-ext', 'U+0100-02BA')
  + face('latin', 'Source Sans Pro', 400, 'normal', 'ssp-400')
  + face('latin', 'Source Sans Pro', 700, 'normal', 'ssp-700')
  + face('latin', 'Source Sans Pro', 400, 'italic', 'ssp-400i')
  + face('latin', 'Titillium Web', 700, 'normal', 'tw-700');

test('a family name is its regular face; weight and style can be given', () => {
  expect(faceOf('Inter')).toEqual({ family: 'Inter', weight: 400, style: 'normal' });
  expect(faceOf({ family: 'Inter', weight: 700, style: 'italic' })).toEqual({ family: 'Inter', weight: 700, style: 'italic' });
  expect(faceName(faceOf({ family: 'Inter', weight: 700, style: 'italic' }))).toBe('Inter 700 italic');
});

test('the Latin file of the face, by family (any case), weight and style', () => {
  expect(fontFaceUrl(GOOGLE, faceOf('Source Sans Pro'))).toBe('https://fonts.gstatic.com/s/ssp-400.woff2');
  expect(fontFaceUrl(GOOGLE, faceOf('source sans pro'))).toBe('https://fonts.gstatic.com/s/ssp-400.woff2');
  expect(fontFaceUrl(GOOGLE, faceOf({ family: 'Source Sans Pro', weight: 700 }))).toBe('https://fonts.gstatic.com/s/ssp-700.woff2');
  expect(fontFaceUrl(GOOGLE, faceOf({ family: 'Source Sans Pro', style: 'italic' }))).toBe('https://fonts.gstatic.com/s/ssp-400i.woff2');
  expect(fontFaceUrl(GOOGLE, faceOf({ family: 'Titillium Web', weight: 700 }))).toBe('https://fonts.gstatic.com/s/tw-700.woff2');
  // not in the stylesheet: no file
  expect(fontFaceUrl(GOOGLE, faceOf('Titillium Web'))).toBeNull();
  expect(fontFaceUrl(GOOGLE, faceOf('Lora'))).toBeNull();
  // without subset comments: the face covering Basic Latin
  expect(fontFaceUrl(GOOGLE.replace(/\/\* [\w-]+ \*\/\n/g, ''), faceOf('Source Sans Pro'))).toBe('https://fonts.gstatic.com/s/ssp-400.woff2');
});

test('the preload tag is a CORS font preload, typed by the file', () => {
  expect(fontPreloadTag('https://f/a.woff2')).toBe('<link rel="preload" as="font" type="font/woff2" href="https://f/a.woff2" crossorigin>');
  expect(fontPreloadTag('/a.woff?v=2')).toBe('<link rel="preload" as="font" type="font/woff" href="/a.woff?v=2" crossorigin>');
  expect(fontPreloadTag('/a')).toBe('<link rel="preload" as="font" href="/a" crossorigin>');
});

test('a variable face spans its weights; minified unicode-range; the woff2 source of several', () => {
  const css = "@font-face{font-family:Figtree Variable;font-weight:300 900;src:url(/a/ext.woff2)format('woff2');unicode-range:U+0100-02BA}"
    + "@font-face{font-family:Figtree Variable;font-style:normal;font-weight:300 900;src:url(/a/lat.woff) format('woff'),url(/a/lat.woff2) format('woff2-variations');unicode-range:U+00??,U+0131}";
  expect(fontFaceUrl(css, faceOf('Figtree Variable'))).toBe('/a/lat.woff2');
  expect(fontFaceUrl(css, faceOf({ family: 'Figtree Variable', weight: 900 }))).toBe('/a/lat.woff2');
  expect(fontFaceUrl(css, faceOf({ family: 'Figtree Variable', weight: 200 }))).toBeNull();
  expect(fontFaceUrl("@font-face{font-family:X;font-weight:bold;src:url(data:font/woff2;base64,AA)format('woff2'),url(/x.woff2)}", faceOf({ family: 'X', weight: 700 }))).toBe('/x.woff2');
});

test('local preloads: relative URLs resolve against the stylesheet, one tag per file', () => {
  const sheets = [{ href: 'assets/app.css', css: "@font-face{font-family:A;font-weight:100 900;src:url(./a.woff2)}" }];
  const out = preloadLocalFonts('<head><meta charset="utf-8"><title>t</title></head>', sheets, [faceOf('A'), faceOf({ family: 'A', weight: 700 }), faceOf('B')]);
  expect(out.html).toBe('<head><meta charset="utf-8"><link rel="preload" as="font" type="font/woff2" href="assets/a.woff2" crossorigin><title>t</title></head>');
  expect(out.preloaded.map(faceName)).toEqual(['A 400', 'A 700']);
});

test('a stylesheet uses a family when a font-family or font declaration outside @font-face names it', () => {
  const cases: Array<[string, string, boolean]> = [
    ["body{font-family:'Source Sans Pro',sans-serif}", 'Source Sans Pro', true],
    ['body{font-family:Source Sans Pro, sans-serif}', 'source sans pro', true],
    ['p{font-family:serif,"Lora" !important}', 'Lora', true],
    ['h1{font:italic 700 1rem/1.5 "Titillium Web", serif}', 'Titillium Web', true],
    ['h1{font:700 2rem Titillium Web,serif}', 'Titillium Web', true],
    // another family that ends with the name
    ['h1{font:2rem Source Sans}', 'Sans', false],
    ['h1{font-family:Source Sans}', 'Sans', false],
    // only declared, or only in a comment
    ["@font-face{font-family:'Lora';src:url(x)} p{color:red}", 'Lora', false],
    ['/* font-family: Lora */ p{color:red}', 'Lora', false],
    // through custom properties (token-based CSS), also through another one, and in the shorthand
    [":root{--tm-font-sans:'Figtree Variable',system-ui}body{font-family:var(--tm-font-sans)}", 'Figtree Variable', true],
    [':root{--brand:Lora;--body:var(--brand),serif}p{font-family:var(--body,serif)}', 'Lora', true],
    [':root{--f:Lora}p{font:1rem/1.5 var(--f)}', 'Lora', true],
    // a custom property that lists the family but no font declaration reads it
    [':root{--f:Lora}p{font-family:serif;color:var(--f)}', 'Lora', false],
    [':root{--f:Lora}p{font-family:var(--g)}', 'Lora', false],
    // a custom property whose name ends in `font` is not a font declaration
    [':root{--my-font:Lora}', 'Lora', false],
  ];
  for (const [css, family, want] of cases) expect([css, usesFamily(css, family)]).toEqual([css, want]);
});

// @vitest-environment node
// Image sizes from utility-CSS engines (src/engines.ts): Tailwind's Vite plugin and UnoCSS,
// each in a real build of a small project. With Playwright installed, the built pages are also
// opened in Chromium: each image must render at the size its files were made for.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import tailwindcss from '@tailwindcss/vite';
import UnoCSS from 'unocss/vite';
import { build, type PluginOption } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` }];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let photo: Buffer;
beforeAll(async () => {
  // noise, so the file is larger than a tiny image (those stay as they are)
  const w = 600, h = 400, raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  photo = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
});

async function project(files: Record<string, string>, plugins: PluginOption[]) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-engines-'));
  dirs.push(root);
  // the engines and their configs load from the project, as in an app
  symlinkSync(resolve(__dirname, '../../node_modules'), join(root, 'node_modules'), 'dir');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'photo.jpg'), photo);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, f), text);
  const out = join(root, 'dist');
  await build({ root, logLevel: 'silent', plugins, resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false } });
  return { html: readFileSync(join(out, 'index.html'), 'utf8'), out };
}

const page = (imgs: string) => `<!doctype html><html><head><script type="module" src="/src/main.js"></script></head><body>${imgs}</body></html>`;
/** width and height an image's files were made for, by alt */
const sizeOf = (html: string, alt: string) => {
  const m = new RegExp(`<img [^>]*alt="${alt}"[^>]*>`).exec(html)![0];
  return { width: Number(/width="(\d+)"/.exec(m)?.[1]), height: Number(/height="(\d+)"/.exec(m)?.[1]), sizes: /sizes="([^"]*)"/.exec(m)?.[1] };
};

test('Tailwind (Vite plugin): utilities the page uses size its images, responsive ones per breakpoint', async () => {
  const { html, out } = await project({
    'src/main.js': "import './app.css';\n",
    'src/app.css': '@import "tailwindcss";\n.card img { @apply size-24 object-cover; }\n',
    'index.html': page(`
<img src="./photo.jpg" class="size-12 rounded-full object-cover" alt="Avatar">
<img src="./photo.jpg" class="w-[72px] aspect-square object-cover" alt="Arbitrary">
<div class="card"><img src="./photo.jpg" alt="Apply"></div>
<img src="./photo.jpg" class="size-12 md:size-20" alt="Responsive">
<img src="./photo.jpg" alt="Plain">`),
  }, [tailwindcss(), sinter()]);
  expect(sizeOf(html, 'Avatar')).toEqual({ width: 48, height: 48, sizes: '(max-width: 3em) 100vw, 3em' });
  expect(sizeOf(html, 'Arbitrary')).toMatchObject({ width: 72, height: 72 });
  expect(sizeOf(html, 'Apply')).toMatchObject({ width: 96, height: 96 });
  expect(sizeOf(html, 'Responsive').sizes).toBe('auto, (max-width: 47.9975em) 3em, 5em');
  // Tailwind's reset: max-width: 100%, so min(source, viewport)
  expect(sizeOf(html, 'Plain').sizes).toBe('auto, (max-width: 599.98px) 100vw, 600px');
  if (!chromium) return;
  // file:// pages load module scripts from /assets: open the built CSS through a relative base instead
  const r = await renderedBuilt(out, html);
  expect(r['Avatar']).toEqual([48, 48]);
  expect(r['Arbitrary']).toEqual([72, 72]);
  expect(r['Apply']).toEqual([96, 96]);
}, 60_000);

test('UnoCSS: the generator with the project\'s config', async () => {
  const { html, out } = await project({
    'uno.config.js': "import { defineConfig, presetWind3 } from 'unocss';\nexport default defineConfig({ presets: [presetWind3()], shortcuts: { thumb: 'w-20 h-20 object-cover' } });\n",
    'src/main.js': "import 'virtual:uno.css';\n",
    'index.html': page(`
<img src="./photo.jpg" class="w-16 h-16 object-cover" alt="Uno">
<img src="./photo.jpg" class="thumb" alt="Shortcut">
<img src="./photo.jpg" class="w-16 md:w-32" alt="Responsive">`),
  }, [UnoCSS(), sinter()]);
  expect(sizeOf(html, 'Uno')).toMatchObject({ width: 64, height: 64 });
  expect(sizeOf(html, 'Shortcut')).toMatchObject({ width: 80, height: 80 });
  expect(sizeOf(html, 'Responsive').sizes).toBe('auto, (max-width: 767.98px) 4em, 8em');
  if (!chromium) return;
  const r = await renderedBuilt(out, html);
  expect(r['Uno']).toEqual([64, 64]);
  expect(r['Shortcut']).toEqual([80, 80]);
}, 60_000);

/** the built page with its stylesheet links made relative, so it renders from disk */
async function renderedBuilt(out: string, html: string) {
  writeFileSync(join(out, 'check.html'), html.replace(/<script[^>]*><\/script>/g, '').replace(/(href|src|srcset)="\/assets\//g, '$1="./assets/').replace(/, \/assets\//g, ', ./assets/'));
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await tab.goto(pathToFileURL(join(out, 'check.html')).href);
    return await tab.evaluate(() => Object.fromEntries([...document.querySelectorAll('img')].map((i) => [i.alt, [i.getBoundingClientRect().width, i.getBoundingClientRect().height]])));
  } finally {
    await browser.close();
  }
}

// @vitest-environment node
// Components through the Vite plugin: scoped styles go into the page's stylesheet, wrapped in
// native @scope from the component's roots to nested components and slot content; Chromium applies them.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-components-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
  mkdirSync(join(root, 'src/components'), { recursive: true });
  writeFileSync(join(root, 'src/components/x-card.html'), `<template data-sn-component="{ title: string }">
  <section class="card"><h2 data-sn-text="title"></h2><p class="own">own</p><x-inner></x-inner><slot></slot></section>
</template>
<style>
  @keyframes pulse { from { opacity: 0 } to { opacity: 1 } }
  .card { padding: 7px; }
  p { color: rgb(0, 0, 255); }
  .card .mine { font-weight: 900; }
</style>
`);
  writeFileSync(join(root, 'src/components/x-inner.html'), '<template data-sn-component=""><div class="inner"><p class="nested">nested</p></div></template>\n');
  writeFileSync(join(root, 'src/components/x-page.html'), `<template data-sn-component=""><main><x-card data-sn-prop="{ title: 'In page' }"><p class="mine">slot</p></x-card></main></template>
<style>p { text-decoration: underline; }</style>
`);
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><title>c</title></head><body>
<div data-sn-state="{ t: 'Hello' }"><x-card data-sn-prop="{ title: t }"><p class="page">from the page</p></x-card></div>
<x-page></x-page>
</body></html>`);
});

test('a build: scoped styles in the page\'s stylesheet, roots and slot content marked, Chromium scopes them', async () => {
  const out = join(root, 'dist');
  await build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false } });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const cssFile = readdirSync(join(out, 'assets')).find((f) => f.endsWith('.css'))!;
  expect(cssFile).toBeDefined();
  expect(html).toContain(`<link rel="stylesheet" crossorigin href="/assets/${cssFile}">`);
  const css = readFileSync(join(out, 'assets', cssFile), 'utf8');
  expect(css).toMatch(/@keyframes pulse/);
  expect(css).toContain('@scope (:has(> [data-sn-c="x-card"]), :has(> [data-sn-s="x-card"])) to (:scope > :not([data-sn-c="x-card"], [data-sn-s="x-card"]), :scope > * [data-sn-c], :scope > * [data-sn-s])');
  expect(css).not.toMatch(/@scope[^{]*\{[^}]*@keyframes/);
  expect(html).toContain('<section class="card" data-sn-c="x-card">');
  expect(html).toContain('<div class="inner" data-sn-c="x-inner">');
  // slot content: the page's, and the one x-page passes into x-card
  expect(html).toContain('<p class="page" data-sn-s="">');
  expect(html).toContain('<p class="mine" data-sn-s="x-page">');
  if (!chromium) return;
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    await tab.setContent(html.replace(/<link rel="stylesheet"[^>]*>/, `<style>${css}</style>`).replace(/<script[\s\S]*?<\/script>/g, ''));
    const style = (sel: string) => tab.$eval(sel, (el) => { const s = getComputedStyle(el); return { color: s.color, weight: s.fontWeight, deco: s.textDecorationLine, pad: s.padding }; });
    expect((await style('.card')).pad).toBe('7px');
    expect((await style('.own')).color).toBe('rgb(0, 0, 255)');
    // a nested component and slot content are not the card's
    expect((await style('.nested')).color).not.toBe('rgb(0, 0, 255)');
    expect((await style('.page')).color).not.toBe('rgb(0, 0, 255)');
    // slot content is its caller's: x-page's styles reach what it passes into the card, also through the card's markup
    expect((await style('.mine')).deco).toBe('underline');
    expect((await style('.mine')).weight).not.toBe('900');
    expect((await style('x-page .own, main .own')).deco).not.toBe('underline');
  } finally {
    await browser.close();
  }
}, 60_000);

test('a component with a script: its base class from its HTML, the generated types, and the built page running it', async () => {
  const app = mkdtempSync(join(tmpdir(), 'sinter-component-script-'));
  try {
    mkdirSync(join(app, 'src/components'), { recursive: true });
    writeFileSync(join(app, 'src/sinter.types.ts'), 'export interface Task { id: number; done: boolean }\n');
    writeFileSync(join(app, 'src/components/task-ring.html'), `<template data-sn-component="{ tasks: Task[] }" data-sn-emits="{ pick: 'done' | 'open' }">
  <figure data-sn-state="{ drawn: 0 }">
    <canvas data-sn-ref="canvas"></canvas>
    <figcaption data-sn-text="tasks.filter((t) => t.done).length + ' done, drawn ' + drawn"></figcaption>
  </figure>
</template>
`);
    writeFileSync(join(app, 'src/components/task-ring.ts'), `import { TaskRingComponent } from './task-ring.html';
export class TaskRing extends TaskRingComponent {
  connected() { this.draw(); this.refs.canvas.addEventListener('click', () => this.emit('pick', 'done')); }
  propsChanged() { this.draw(); }
  draw() { this.refs.canvas.width = 10 + this.props.tasks.length; this.state.drawn = this.state.drawn + 1; }
}
`);
    writeFileSync(join(app, 'index.html'), `<!doctype html><html><head><title>t</title></head><body>
<div data-sn-state="{ tasks: [{ id: 1, done: true }, { id: 2, done: false }], picked: '' }">
  <task-ring data-sn-prop="{ tasks }" data-sn-on-pick="picked = $event.detail"></task-ring>
  <button data-sn-on-click="tasks = [...tasks, { id: 3, done: true }]">add</button>
  <output data-sn-text="picked"></output>
</div>
</body></html>`);
    const out = join(app, 'dist');
    await build({ root: app, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false } });
    // the types: written with the build, and the script checks against them
    const dts = readFileSync(join(app, 'src/sinter.components.d.ts'), 'utf8');
    expect(dts).toContain("declare module '*/task-ring.html' {");
    expect(dts).toContain("type Task = import('./sinter.types').Task;");
    expect(dts).toContain('export class TaskRingComponent extends Base<{ tasks: Task[] }, { pick: \'done\' | \'open\' }, { canvas: HTMLElementTagNameMap["canvas"] }, { drawn: number }> {}');
    const { findTsc } = await import('../../src/check/index.js');
    const { spawnSync } = await import('node:child_process');
    const tsconfig = (files: string[]) => JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2023', 'dom', 'dom.iterable'], allowImportingTsExtensions: true, skipLibCheck: true,
      paths: { '@tiaforge-ui/sinter/components': [join(src, 'components.ts')] } }, files });
    writeFileSync(join(app, 'tsconfig.json'), tsconfig(['src/sinter.components.d.ts', 'src/components/task-ring.ts']));
    const tsc = (path = app) => spawnSync(process.execPath, [findTsc(process.cwd()), '-p', path], { encoding: 'utf8' }).stdout;
    expect(tsc()).toBe('');
    writeFileSync(join(app, 'src/components/task-ring.ts'), readFileSync(join(app, 'src/components/task-ring.ts'), 'utf8').replace("this.emit('pick', 'done')", "this.emit('pik', 'done')"));
    expect(tsc()).toMatch(/Argument of type '"pik"' is not assignable/);
    if (!chromium) return;
    const { preview } = await import('vite');
    const server = await preview({ root: app, logLevel: 'silent', preview: { port: 0 }, build: { outDir: out } });
    const browser = await chromium.launch();
    try {
      const tab = await browser.newPage();
      await tab.goto(server.resolvedUrls!.local[0]!);
      await tab.waitForFunction(() => document.querySelector('figcaption')?.textContent === '1 done, drawn 1');
      expect(await tab.$eval('canvas', (c) => (c as HTMLCanvasElement).width)).toBe(12);
      await tab.click('button');
      await tab.waitForFunction(() => document.querySelector('figcaption')?.textContent === '2 done, drawn 2');
      expect(await tab.$eval('canvas', (c) => (c as HTMLCanvasElement).width)).toBe(13);
      await tab.click('canvas');
      await tab.waitForFunction(() => document.querySelector('output')?.textContent === 'done');
    } finally {
      await browser.close();
      await new Promise((r) => server.httpServer.close(r));
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}, 60_000);

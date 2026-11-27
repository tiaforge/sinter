// @vitest-environment node
// Lazy packages reached through the app's own module resolution (docs/lazy.md): an import through a Vite
// `resolve.alias`, or of a `.mts` file, is followed as a relative import is, as the fold check follows it. A helper
// module that reaches the package that way loads whole with it (no SN324 for its sync calls), and a component
// script that does is preloaded with it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const root = mkdtempSync(join(tmpdir(), 'sinter-lazy-alias-'));
const out = join(root, 'dist');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` },
  { find: '@lib', replacement: join(root, 'src/lib') }];
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
const MARK = 'FAKEPGP_' + 'BODY';

beforeAll(async () => {
  put('node_modules/fakepgp/package.json', JSON.stringify({ name: 'fakepgp', version: '1.0.0', type: 'module', main: 'index.js' }));
  put('node_modules/fakepgp/index.js', `const body = '${MARK}'.repeat(200);\nexport function parse(t) { return 'parse(' + t + ')' + body.length; }\nexport class Thing { say(n) { return 'thing ' + n; } }\n`);
  put('src/sinter.helpers.ts', `export * as viaAlias from './lib/via-alias.ts';\nexport * as viaMts from './lib/via-mts.ts';\n`);
  // through the alias, then a sync call of the package: SN324 unless the module loads whole with it
  put('src/lib/via-alias.ts', `import { parsed } from '@lib/parse-a';\nexport function render(s: string) { return parsed(s); }\n`);
  put('src/lib/parse-a.ts', `import { parse } from 'fakepgp';\nexport const parsed = (s: string) => 'ALIAS_' + parse(s);\n`);
  // a `.mts` module, imported without its extension
  put('src/lib/via-mts.ts', `import { parsed } from './parse-b';\nexport function render(s: string) { return parsed(s); }\n`);
  put('src/lib/parse-b.mts', `import { parse } from 'fakepgp';\nexport const parsed = (s: string) => 'MTS_' + parse(s);\n`);
  put('src/components/x-ring.html', `<template data-sn-props="{ n: number }"><p data-sn-state="{ said: '' }"><span data-sn-text="said"></span></p></template>\n`);
  put('src/components/x-ring.ts', `import { XRingComponent } from './x-ring.html';\nimport { said } from '@lib/said';\nexport class XRing extends XRingComponent { async connected() { this.state.said = await said(this.props.n); } }\n`);
  put('src/lib/said.ts', `import { parse } from 'fakepgp';\nexport const said = async (n: number) => await parse(String(n));\n`);
  put('index.html', `<!doctype html><html><head><title>alias</title></head><body>
<main data-sn-state="{ src: 'hi' }" data-sn-let="{ a: viaAlias.render(src), b: viaMts.render(src) }"><p data-sn-text="a ?? 'waiting'"></p><p data-sn-text="b ?? 'waiting'"></p></main>
</body></html>`);
  put('comp.html', `<!doctype html><html><head><title>comp</title></head><body>
<div data-sn-state="{ n: 1 }" data-sn-preload="fakepgp"><x-ring data-sn-with="{ n }"></x-ring></div>
</body></html>`);
  await build({ root, logLevel: 'silent', plugins: [sinter({ lazy: ['fakepgp'] })], resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input: { index: join(root, 'index.html'), comp: join(root, 'comp.html') } } } });
}, 60_000);

const assets = () => readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
const read = (f: string) => readFileSync(join(out, 'assets', f), 'utf8');

test('helper modules that reach the package through an alias or a .mts file load whole with it, as through a relative import', () => {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const entry = /<script type="module" crossorigin src="\/assets\/([^"]+)"/.exec(html)![1]!;
  const page = read(entry);
  expect(page).toMatch(/later\(\(\) => __vitePreload\(\(\) => import\("\.\/via-alias-/);
  expect(page).toMatch(/later\(\(\) => __vitePreload\(\(\) => import\("\.\/via-mts-/);
  // their calls of the package are its own functions, no stubs
  for (const tag of ['ALIAS_', 'MTS_']) {
    const chunk = assets().find((f) => read(f).includes(tag))!;
    expect(chunk).toBeDefined();
    expect(read(chunk)).not.toContain('/@sinter/lazy/');
  }
});

test('a component script that reaches the package through an alias loads with it, and data-sn-preload preloads it', () => {
  const html = readFileSync(join(out, 'comp/index.html'), 'utf8');
  const script = assets().find((f) => f.startsWith('x-ring-'))!;
  expect(script).toBeDefined();
  expect(read(script)).not.toContain(MARK);
  expect(html).toContain(`<link rel="modulepreload" crossorigin fetchpriority="low" href="/assets/${script}">`);
});

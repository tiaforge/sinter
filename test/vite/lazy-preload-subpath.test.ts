// @vitest-environment node
// `data-sn-preload` names a lazy package the app imports through a subpath (`sinter({ lazy: ['subpkg'] })`,
// `import … from 'subpkg/parser'`), as an app preloads @tiaforge-ui/sinter-markdown, whose md.parse imports
// `@tiaforge-ui/sinter-markdown/parser`: the subpath's chunk is preloaded, and there is no SN520.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-lazy-subpath-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };

test('a lazy package imported through a subpath: data-sn-preload with its name preloads the subpath\'s chunk', async () => {
  put('node_modules/subpkg/package.json', JSON.stringify({ name: 'subpkg', version: '1.0.0', type: 'module', exports: { '.': './index.js', './parser': './parser.js' } }));
  put('node_modules/subpkg/index.js', 'export const name = "subpkg";\n');
  put('node_modules/subpkg/parser.js', `export function tokenize(s) { return ['SUBPKG_PARSER', s]; }\n`);
  put('src/sinter.helpers.ts', `import { tokenize } from 'subpkg/parser';\nexport function words(s: string | undefined) { return tokenize(s ?? '').join(' '); }\n`);
  put('index.html', `<!doctype html><html><head><title>preload</title></head><body>
<main data-sn-state="{ s: 'a' }" data-sn-preload="subpkg"><p data-sn-let="{ w: words(s) }" data-sn-text="w"></p></main>
</body></html>`);
  const warnings: string[] = [];
  await build({
    root, logLevel: 'silent', plugins: [sinter({ lazy: ['subpkg'] })], resolve: { alias },
    customLogger: { info() {}, warn: (m) => warnings.push(m), warnOnce: (m) => warnings.push(m), error() {}, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
    build: { outDir: join(root, 'dist'), emptyOutDir: true, minify: false },
  });
  const assets = readdirSync(join(root, 'dist/assets')).filter((f) => f.endsWith('.js'));
  const parser = assets.find((f) => readFileSync(join(root, 'dist/assets', f), 'utf8').includes('SUBPKG_PARSER'));
  expect(parser).toBeTruthy();
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  expect(html).toContain(`<link rel="modulepreload" crossorigin fetchpriority="low" href="/assets/${parser}">`);
  expect(warnings.join('\n')).not.toContain('SN520');
}, 60_000);

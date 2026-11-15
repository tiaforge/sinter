// @vitest-environment node
// The helpers module in Node (src/helpers-node.ts): loaded through Vite with the app's config (its
// aliases and plugins apply), sinter inert in the server that loads it; a module that cannot load
// there folds nothing, with one warning (SN533).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import { loadHelpers } from '../../src/helpers-node.js';
import { readHelperManifest } from '../../src/compiler/index.js';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** a project whose Vite config has an alias, a plugin with a virtual module, and sinter */
function app(helpers: string) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-helpers-node-'));
  dirs.push(root);
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  put('package.json', '{"type":"module"}');
  put('vite.config.js', `import { fileURLToPath } from 'node:url';
import sinter from ${JSON.stringify(join(src, 'vite.ts'))};
const virtual = { name: 'greeting', resolveId: (id) => (id === 'virtual:greeting' ? '\\0greeting' : null), load: (id) => (id === '\\0greeting' ? 'export const hello = "hi from a plugin";' : null) };
export default { resolve: { alias: { '@lib': fileURLToPath(new URL('./src/lib', import.meta.url)) } }, plugins: [virtual, sinter()] };
`);
  put('src/lib/words.ts', 'export const shout = (s: string): string => s.toUpperCase() + "!";\n');
  put('src/sinter.helpers.ts', helpers);
  put('index.html', '<!doctype html><html><head><title>x</title></head><body><main data-sn-state="{ s: \'a\' }"><p data-sn-text="loud(s)"></p></main></body></html>');
  return root;
}
const manifestOf = (root: string) => readHelperManifest(readFileSync(join(root, 'src/sinter.helpers.ts'), 'utf8'), { module: '/src/sinter.helpers.ts', file: join(root, 'src/sinter.helpers.ts'), readFile: (f) => readFileSync(f, 'utf8') });

test('loaded with the app\'s Vite config: its alias and its plugins apply; sinter is inert in the server that loads it', async () => {
  const root = app(`import { shout } from '@lib/words';\nimport { hello } from 'virtual:greeting';\nexport const loud = (s: string) => shout(s);\nexport const greet = () => hello;\n`);
  const h = await loadHelpers({ root, helpersFile: join(root, 'src/sinter.helpers.ts'), manifest: manifestOf(root) });
  expect(h.error).toBeNull();
  expect((h.module!.loud as (s: string) => string)('a')).toBe('A!');
  expect((h.module!.greet as () => string)()).toBe('hi from a plugin');
  // the static check's verdicts come with it
  expect(h.fold.get('loud')).toEqual({ fold: true });
  expect(h.files).toContain(join(root, 'src/lib/words.ts'));
}, 60_000);

test('a module that cannot load in Node: no module, the reason, and the build warns once (SN533) and still builds', async () => {
  const root = app('const w = window.innerWidth;\nexport const loud = (s: string) => s + w;\n');
  const h = await loadHelpers({ root, helpersFile: join(root, 'src/sinter.helpers.ts'), manifest: manifestOf(root) });
  expect(h.module).toBeNull();
  expect(h.error).toMatch(/window is not defined/);
  const lines: string[] = [];
  const logger = { info: () => {}, warn: (m: string) => { lines.push(m); }, warnOnce: (m: string) => { lines.push(m); }, error: (m: string) => { lines.push(m); }, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false };
  await build({ root, configFile: false, customLogger: logger, plugins: [sinter()], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: { index: join(root, 'index.html') } } } });
  const warned = lines.filter((l) => l.includes('SN533'));
  expect(warned).toHaveLength(1);
  expect(warned[0]).toContain('the helpers module could not be loaded in Node (src/sinter.helpers.ts: window is not defined)');
}, 60_000);

test('sinter check loads it the same way: a module that cannot load in Node is SN533 at the helpers module', () => {
  const root = app("import { w } from './gone.js';\nexport const loud = (s: string) => s + w;\n");
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(resolve(__dirname, '../../node_modules/typescript'), join(root, 'node_modules/typescript'));
  const r = spawnSync(process.execPath, [resolve(__dirname, '../../node_modules/jiti/lib/jiti-cli.mjs'), resolve(__dirname, '../../src/cli.ts'), 'check', '--root', root, 'index.html'], { encoding: 'utf8', env: { ...process.env, SINTER_STRICT: '' } });
  const out = r.stdout + r.stderr;
  expect(r.status, out).toBe(0);
  expect(out).toMatch(/src\/sinter\.helpers\.ts:1:1 warning SN533 helpers-unloaded: the helpers module could not be loaded in Node \(src\/sinter\.helpers\.ts/);
}, 60_000);

test('loading the helpers runs none of the app\'s dev-server hooks: a mock API\'s timer does not keep `vite build` alive', () => {
  const root = mkdtempSync(join(tmpdir(), 'sinter-helpers-hooks-'));
  dirs.push(root);
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  put('package.json', '{"type":"module"}');
  // as a mock API plugin does: a timer started in configureServer, cleared only when the HTTP server closes
  put('vite.config.js', `import sinter from ${JSON.stringify(join(src, 'vite.ts'))};
const api = { name: 'mock-api', configureServer(server) {
  globalThis.__hooked = (globalThis.__hooked ?? 0) + 1;
  const t = setInterval(() => {}, 1000);
  server.httpServer?.on('close', () => clearInterval(t));
} };
export default { resolve: { alias: ${JSON.stringify(alias.map((a) => ({ find: a.find.source, replacement: a.replacement })))}.map((a) => ({ find: new RegExp(a.find), replacement: a.replacement })) }, plugins: [api, sinter({ static: true })] };
`);
  put('src/sinter.helpers.ts', 'export const loud = (s: string): string => s.toUpperCase();\n');
  put('index.html', '<!doctype html><html><head><title>x</title></head><body><main data-sn-state="{ s: \'a\' }"><p data-sn-text="loud(s)"></p></main></body></html>');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [resolve(__dirname, '../../node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'], { cwd: root, encoding: 'utf8', timeout: 90_000 });
  expect(r.signal, `vite build was still running after ${Date.now() - t0} ms`).toBe(null);
  expect(r.status, r.stderr).toBe(0);
  // the helper ran at build time (in the loader, and again in the build's cross-check)
  expect(readFileSync(join(root, 'dist/index.html'), 'utf8')).toContain('<p>A</p>');
}, 120_000);

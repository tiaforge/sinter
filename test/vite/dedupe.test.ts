// One sinter for the app and its libraries (docs/libraries.md#using-one): a library linked from outside the root
// (`file:`, `npm link`) has its own node_modules with its own sinter. Imported from the library's files, sinter
// resolved to that copy, whose `instance()` knew none of the app's mounts. The plugin adds sinter to `resolve.dedupe`.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'sinter-dedupe-')));
const app = join(base, 'app'), lib = join(base, 'lib');
const pkg = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), 'export const copy = 1;\n');
};
// the app's sinter and the library's own (a stand-in package: only where it resolves is looked at)
pkg(join(app, 'node_modules/@tiaforge-ui/sinter'), '@tiaforge-ui/sinter');
pkg(join(lib, 'node_modules/@tiaforge-ui/sinter'), '@tiaforge-ui/sinter');
pkg(lib, '@fixture/linked');
writeFileSync(join(lib, 'script.js'), "import { copy } from '@tiaforge-ui/sinter';\nexport { copy };\n");
mkdirSync(join(app, 'node_modules/@fixture'), { recursive: true });
symlinkSync(lib, join(app, 'node_modules/@fixture/linked'), 'dir');
writeFileSync(join(app, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
afterAll(() => rmSync(base, { recursive: true, force: true }));

const resolved = async (plugins: unknown[]) => {
  const server = await createServer({ root: app, configFile: false, logLevel: 'silent', server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, plugins: plugins as never });
  try {
    const r = await server.pluginContainer.resolveId('@tiaforge-ui/sinter', join(lib, 'script.js'));
    return realpathSync(r!.id.replace(/\?.*$/, ''));
  } finally { await server.close(); }
};

test("a linked library's import of sinter resolves to the app's copy", async () => {
  // without the plugin, the library's own copy (the bug)
  expect(await resolved([])).toBe(join(lib, 'node_modules/@tiaforge-ui/sinter/index.js'));
  expect(await resolved([sinter()])).toBe(join(app, 'node_modules/@tiaforge-ui/sinter/index.js'));
});

test("the app's own dedupe list is kept", async () => {
  const server = await createServer({ root: app, configFile: false, logLevel: 'silent', server: { middlewareMode: true, ws: false }, resolve: { dedupe: ['other'] }, plugins: [sinter()] });
  try { expect(server.config.resolve.dedupe).toEqual(expect.arrayContaining(['other', '@tiaforge-ui/sinter'])); } finally { await server.close(); }
});

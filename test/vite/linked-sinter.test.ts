// @vitest-environment node
// An app whose node_modules/@tiaforge-ui/sinter is a link to a sinter checkout (`npm link`, `file:`): the
// package's files are outside node_modules by their real path, and the plugin took them for the app's own
// modules, failing on its own source (`clearPersisted()` is renamed to `clearStored()`, the retired-export check).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const repo = resolve(__dirname, '../..');
const app = realpathSync(mkdtempSync(join(tmpdir(), 'sinter-linked-')));
mkdirSync(join(app, 'node_modules/@tiaforge-ui'), { recursive: true });
symlinkSync(repo, join(app, 'node_modules/@tiaforge-ui/sinter'), 'dir');
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
writeFileSync(join(app, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
afterAll(() => rmSync(app, { recursive: true, force: true }));

test("a linked sinter's own modules are not checked as the app's", async () => {
  const server = await createServer({ root: app, configFile: false, logLevel: 'silent', server: { middlewareMode: true, ws: false, fs: { allow: [app, repo] } }, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [sinter()] });
  try {
    // src/project.ts names `clearPersisted` and imports of `@tiaforge-ui/sinter` (the check itself)
    const r = await server.transformRequest('/node_modules/@tiaforge-ui/sinter/src/project.ts');
    expect(r?.code).toContain('clearPersisted');
    // an app module still fails
    writeFileSync(join(app, 'old.js'), "import { clearPersisted } from '@tiaforge-ui/sinter';\nclearPersisted();\n");
    await expect(server.transformRequest('/old.js')).rejects.toThrow(/clearStored/);
  } finally { await server.close(); }
});

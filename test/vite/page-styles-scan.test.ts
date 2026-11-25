// @vitest-environment node
// pageStyles (src/styles.ts) scans the app's modules for the stylesheets they import, for every page; a module's
// import list is kept by its file while its text is the same, and read again when the file changes (dev, --watch).
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { pageStyles } from '../../src/styles.js';

const root = mkdtempSync(join(tmpdir(), 'sinter-page-styles-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (f: string, s: string, t?: number) => { writeFileSync(join(root, f), s); if (t) utimesSync(join(root, f), t, t); };

test('the stylesheets the modules import, on every page; a module edited is scanned again', async () => {
  put('a.css', '.a { color: red }');
  put('b.css', '.b { color: blue }');
  put('lib.ts', "import './a.css';\n// import './b.css';\nexport const x = 1;", 1000);
  put('helpers.ts', "/* import './b.css' */ export { x } from './lib.ts';", 1000);
  let resolves = 0;
  const ctx = { root, publicDir: null, modules: [join(root, 'helpers.ts')], resolve: async (id: string, importer: string) => { resolves++; return resolve(dirname(importer), id); } };
  const page = '<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>';
  const files = async (f: string) => (await pageStyles(page, join(root, f), ctx)).map((s) => s.file.slice(root.length + 1));
  expect(await files('p1.html')).toEqual(['a.css']);
  expect(await files('p2.html')).toEqual(['a.css']);
  // each page still resolves what the modules import (the importer may differ), only the scan of the text is kept
  expect(resolves).toBe(6);
  put('lib.ts', "import './b.css';\nimport './a.css';\nexport const x = 1;", 2000);
  expect(await files('p3.html')).toEqual(['b.css', 'a.css']);
  // a module script in the page itself is scanned as it is
  expect((await pageStyles(page.replace('<p>', '<script type="module">import "./b.css"</script><p>'), join(root, 'p4.html'), { ...ctx, modules: [] })).map((s) => s.file.slice(root.length + 1))).toEqual(['b.css']);
});

test("a plugin's virtual `@import` is left out, and the rest of the stylesheet is read (Vite's CSS pipeline)", async () => {
  const { preprocessCSS, resolveConfig } = await import('vite');
  const config = await resolveConfig({ root, configFile: false, logLevel: 'silent' }, 'build');
  put('site.css', "@import 'virtual:icons.css';\n@import url(\"virtual:core.css\") layer(base);\n@import './a.css';\n.wrap { max-width: 83em }");
  put('a.css', '.a { color: red }');
  const compile = async (code: string, file: string) => { const out = await preprocessCSS(code, file, config); return { code: out.code, deps: [...(out.deps ?? [])] }; };
  const page = '<!doctype html><html><head><link rel="stylesheet" href="/site.css"></head><body><p>x</p></body></html>';
  const [sheet, ...rest] = await pageStyles(page, join(root, 'v.html'), { root, publicDir: null, modules: [], resolve: async (id, importer) => resolve(dirname(importer), id), compile });
  expect(rest).toEqual([]);
  expect(sheet!.css).toContain('max-width: 83em');
  expect(sheet!.css).toContain('.a { color: red }');
  expect(sheet!.css).not.toMatch(/@import/);
  // without it, the pipeline opens the import as a file and the whole stylesheet fails
  await expect(compile("@import 'virtual:icons.css';\n.wrap { max-width: 83em }", join(root, 'site.css'))).rejects.toThrow(/ENOENT/);
});

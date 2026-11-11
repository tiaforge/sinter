#!/usr/bin/env node
// `sinter check [--root <dir>] [--check-cycles] [page.html …]`: compiles the pages and type-checks
// their expressions. Without pages, it reads them and the plugin options from the
// Vite config. `sinter lsp`: the language server for editors.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { check } from './check/index.js';
import { compile, formatDiagnostic, type CheckUnit, type Diagnostic } from './compiler/index.js';
import { project, staticPages, viteProject, type ProjectOptions } from './project.js';
import { lazyDiagnostics, resolveFile } from './lazy-build.js';

const USAGE = 'usage: sinter check [--root <dir>] [--check-cycles] [page.html …]\n       sinter lsp [--stdio]';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'lsp') return lsp();
  if (command !== 'check') {
    console.error(USAGE);
    return 2;
  }
  let root = process.cwd();
  const pages: string[] = [];
  let cycles = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--root') root = resolve(rest[++i] ?? '.');
    else if (rest[i] === '--check-cycles') cycles = true;
    else pages.push(rest[i]!);
  }
  let options: ProjectOptions = {};
  let files = pages.map((p) => resolve(root, p));
  if (!files.length) ({ pages: files, options } = await viteProject(root));
  if (!files.length) {
    console.error(`sinter check: no pages found; pass them as arguments\n${USAGE}`);
    return 2;
  }

  const p = project(root, options);
  const diagnostics: Diagnostic[] = [...p.diagnostics];
  const units: CheckUnit[] = [];
  for (const file of files) {
    const out = compile(readFileSync(file, 'utf8'), { file, root, dev: false, helpers: p.helpers, actions: p.actions, config: p.config, readFile: p.readFile, check: true, openapi: p.openapi, complexity: p.complexity, componentNames: p.componentNames, checkCycles: p.checkCycles || cycles, ...(p.isStatic(file) ? { static: true, prerender: true } : {}) });
    diagnostics.push(...out.diagnostics);
    if (out.check) units.push(out.check);
  }
  // a `static` pattern that matches no page (with the pages from the Vite config)
  if (!pages.length && Array.isArray(options.static)) {
    for (const m of staticPages(root, options.static).unmatched(files)) diagnostics.push({ severity: 'error', code: 'SN322', message: `sinter({ static }): no page matches \`${m}\``, file: resolve(root, 'vite.config'), line: 1, col: 1 });
  }
  // lazy packages: uses a stub cannot serve, in the app's modules (SN324)
  if (p.lazy.length) {
    const mod = (url: string | null) => (url ? resolveFile(url, resolve(root, 'index.html'), root) : null);
    const scripts = p.componentNames.map((n) => resolveFile(`/src/components/${n}.ts`, root, root) ?? resolveFile(`/src/components/${n}.js`, root, root)).filter((f): f is string => !!f);
    diagnostics.push(...lazyDiagnostics(root, p.lazy, [p.helpersFile, p.actionsFile, mod(p.config), mod(p.early)], p.helpersFile, scripts));
  }
  const r = check({ root, units, helpers: p.helpers, actions: p.actions, types: p.types, openapi: p.openapi, messagesTypes: p.messagesTypes });
  diagnostics.push(...r.diagnostics);

  for (const d of diagnostics) console.log(formatDiagnostic({ ...d, file: relative(process.cwd(), d.file) || d.file }) + '\n');
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  console.log(`sinter check: ${files.length} page(s), ${errors} error(s), ${warnings} warning(s); ${r.typed} of ${r.resources} resources typed${r.openapi ? ` (${r.openapi} via OpenAPI)` : ''}`);
  return errors ? 1 : 0;
}

/** Language server over stdio; stdout carries only protocol messages. */
async function lsp(): Promise<number> {
  const toStderr = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
  console.log = console.info = console.warn = console.debug = toStderr;
  const { startServer } = await import('./lsp/server.js');
  return new Promise((done) => {
    const conn = startServer(process.stdin, process.stdout, { exit: (code) => process.exit(code) });
    const closed = conn.onClose;
    conn.onClose = () => { closed?.(); done(0); };
  });
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
  console.error(`sinter check: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});

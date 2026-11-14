#!/usr/bin/env node
// `sinter check [--root <dir>] [--check-cycles] [page.html …]`: compiles the pages and type-checks
// their expressions. Without pages, it reads them and the plugin options from the
// Vite config. `sinter lsp`: the language server for editors.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { check } from './check/index.js';
import { compile, formatDiagnostic, type CheckUnit, type Diagnostic } from './compiler/index.js';
import { project, staticPages, viteProject, type ProjectOptions } from './project.js';
import { lazyDiagnostics, resolveFile } from './lazy-build.js';

const USAGE = 'usage: sinter check [--root <dir>] [--check-cycles] [page.html …]\n       sinter migrate [--root <dir>] [--write]\n       sinter lsp [--stdio]';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'lsp') return lsp();
  if (command === 'migrate') return migrate(rest);
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
    const out = compile(readFileSync(file, 'utf8'), { file, root, dev: false, helpers: p.helpers, actions: p.actions, config: p.config, readFile: p.readFile, check: true, openapi: p.openapi, apis: p.apis, complexity: p.complexity, componentNames: p.componentNames, checkCycles: p.checkCycles || cycles, lazy: p.lazy, ...(p.isStatic(file) ? { static: true, prerender: true } : {}) });
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

/**
 * `sinter migrate [--root <dir>] [--write]`: the URLs of the pages, components and layouts become paths
 * relative to the APIs of `sinter({ apis })` (printed; written with `--write`), and what to add to the
 * config is printed: the shapes every page agrees on, and the endpoints no API declares.
 */
async function migrate(args: string[]): Promise<number> {
  let root = process.cwd(), write = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = resolve(args[++i] ?? '.');
    else if (args[i] === '--write') write = true;
    else { console.error(USAGE); return 2; }
  }
  const { migrateMarkup, configReport, formatReport, followUp, addQuery, removeAttributes } = await import('./migrate.js');
  const { pages, options } = await viteProject(root);
  if (!options.apis) {
    const specs = options.openapi == null ? [] : ([] as string[]).concat(options.openapi);
    console.error('sinter migrate: configure the APIs first, in the Vite config (docs/apis.md), then run it again:\n');
    console.error(`  sinter({ apis: { main: { ${specs.length ? `openapi: ${JSON.stringify(specs.length > 1 ? specs : specs[0])}` : "base: '/api'"} } } })\n`);
    if (specs.length) console.error('  (the base is the spec\'s first server; set `base` for another; remove the top-level `openapi`' + ((options as { origins?: string[] }).origins?.length ? ', and the API origins from `origins`)' : ')'));
    return 1;
  }
  const p = project(root, options);
  const errors = p.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length || !p.apis) { for (const d of errors) console.error(formatDiagnostic(d)); return 1; }
  const html = (dir: string) => { try { return readdirSync(join(root, dir)).filter((f) => f.endsWith('.html')).map((f) => join(root, dir, f)); } catch { return []; } };
  const files = [...new Set([...pages, ...html('src/components'), ...html('src/layouts')])];
  // 1. the URLs, in memory
  const texts = new Map<string, string>(), changed = new Set<string>();
  const uses = [];
  for (const file of files) {
    const r = migrateMarkup(readFileSync(file, 'utf8'), file, p.apis, p.openapi);
    uses.push(...r.uses);
    texts.set(file, r.text);
    const rel = relative(root, file);
    for (const w of r.rewrites) console.log(`${rel}:${w.line}  ${w.from}  →  ${w.to}`);
    for (const w of r.unsure) console.log(`${rel}:${w.line}  ${w.from}  is a path of the default API now; write ${w.to} if it is the page's own`);
    if (r.rewrites.length) changed.add(file);
  }
  // 2. the migrated pages, compiled: the query parameters to declare, the attributes the config makes redundant
  const read = (f: string) => texts.get(f) ?? p.readFile(f);
  const diagnostics = pages.flatMap((file) => compile(read(file), { file, root, dev: false, helpers: p.helpers, actions: p.actions, config: p.config, readFile: read, openapi: p.openapi, apis: p.apis, componentNames: p.componentNames, lazy: p.lazy }).diagnostics);
  const fu = followUp(diagnostics);
  const report = configReport(uses, p.apis, p.openapi);
  addQuery(report, fu.query, p.apis, p.openapi);
  // 3. with --write: the files, without the attributes the config already says
  const byFile = new Map<string, Array<(typeof fu.redundant)[number]['span']>>();
  for (const r of fu.redundant) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r.span]);
  if (write) {
    for (const [file, spans] of byFile) { texts.set(file, removeAttributes(read(file), spans)); changed.add(file); }
    for (const file of changed) writeFileSync(file, texts.get(file)!);
  }
  console.log(`\nsinter migrate: ${changed.size} file(s) ${write ? 'rewritten' : 'to rewrite (run with --write)'}`);
  if (fu.redundant.length) console.log(`${fu.redundant.length} attribute(s) restate what the config says (SN518): ${write ? 'removed' : 'removed with --write'}`);
  const text = formatReport(report);
  if (text) console.log(`\nAdd to sinter({ apis }), then run it again with --write to remove the attributes the config then says:\n${text}`);
  if (report.disagree.length) console.log(`\nPages disagree, so the attributes stay on them: ${report.disagree.join('; ')}`);
  if (fu.notes.length) console.log(`\nFor you to fix:\n${fu.notes.map((n) => '  ' + relative(root, n.split(':')[0]!) + n.slice(n.indexOf(':'))).join('\n')}`);
  return 0;
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

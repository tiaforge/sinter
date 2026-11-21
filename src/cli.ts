#!/usr/bin/env node
// `sinter check [--root <dir>] [--strict [--allow <codes>]] [page.html …]`: compiles the
// pages and type-checks their expressions; `--strict` (or `SINTER_STRICT=1`) fails on warnings too. Without pages, it reads them and the plugin options from the
// Vite config. `sinter render page.html`: the page with mocked data, driven by steps, without a browser. `sinter docs [topic]`: one part of llms.txt or a diagnostic's explanation. `sinter lsp`: the language server for editors.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { check } from './check/index.js';
import { applyStrict, compile, formatDiagnostic, type CheckUnit, type Diagnostic } from './compiler/index.js';
import { project, staticPages, strictEnv, viteProject, type ProjectOptions } from './project.js';
import { lazyDiagnostics, lazyHelpers, resolveFile } from './lazy-build.js';
import { loadHelpers, unloadedMessage } from './helpers-node.js';
import { checkLocale } from './locales-build.js';
import { readSnapshot, snapshotNamespaces } from './content-node.js';
import { componentScript } from './components-build.js';
import { CODES, severityOf, strictPromotes, type Code } from './compiler/diagnostics.js';

const USAGE = 'usage: sinter check [--root <dir>] [--strict [--allow SN501,…]] [page.html …]\n       sinter docs [topic | data-sn-… | SN318 | words]\n       sinter render <page.html> [--url …] [--api mocks.json | http://…] [--click …] (sinter render --help)\n       sinter migrate [--root <dir>] [--write]\n       sinter lsp [--stdio]';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'lsp') return lsp();
  if (command === 'migrate') return migrate(rest);
  if (command === 'docs') return docs(rest);
  if (command === 'render') return (await import('./render-cli.js')).renderCommand(rest);
  if (command !== 'check') {
    console.error(USAGE);
    return 2;
  }
  let root = process.cwd();
  const pages: string[] = [];
  let strictFlag: boolean | null = null;
  const allow = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--root') root = resolve(rest[++i] ?? '.');
    else if (a === '--check-cycles') { console.error('sinter check: --check-cycles is gone: SN509 is reported on every run, and `--allow SN509` (or `strict: { allow }`) keeps a deliberate cycle a warning'); return 2; }
    else if (a === '--strict') strictFlag = true;
    else if (a === '--no-strict') strictFlag = false;
    else if (a === '--allow' || a.startsWith('--allow=')) {
      const list = a === '--allow' ? rest[++i] : a.slice('--allow='.length);
      const codes = (list ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
      const bad = codes.filter((c) => !(c in CODES) || severityOf(c as Code) === 'error' || !strictPromotes(c));
      if (!codes.length || bad.length) { console.error(`sinter check: --allow takes the codes of warnings strict mode fails on, such as --allow SN501,SN518${bad.length ? ` (not one: ${bad.join(', ')})` : ''}\n${USAGE}`); return 2; }
      for (const c of codes) allow.add(c);
    } else if (a.startsWith('--')) { console.error(`sinter check: unknown option ${a}\n${USAGE}`); return 2; }
    else pages.push(a);
  }
  let options: ProjectOptions = {};
  let files = pages.map((p) => resolve(root, p));
  if (!files.length) ({ pages: files, options } = await viteProject(root));
  if (!files.length) {
    console.error(`sinter check: no pages found; pass them as arguments\n${USAGE}`);
    return 2;
  }

  const p = project(root, options);
  // the flag, else SINTER_STRICT, else sinter({ strict }); its `allow` joins --allow
  const strict = strictFlag ?? strictEnv(process.env.SINTER_STRICT) ?? p.strict.on;
  for (const c of p.strict.allow.keys()) allow.add(c);
  let diagnostics: Diagnostic[] = [...p.diagnostics];
  const units: CheckUnit[] = [];
  // `localePrefix`: the build compiles each page in a language (`$locale` fixed, `localeUrl()`); checked in the base one
  const locale = checkLocale(root, options as ProjectOptions & { localePrefix?: boolean });
  // collections: from the build's snapshot (the check runs no loaders); typed from the content module
  const snap = p.contentFile ? readSnapshot(root, p.contentFile) : null;
  if (p.contentFile && !snap) console.error('sinter check: the content module\'s collections have no snapshot yet (vite build or vite dev writes one): what pages read of them is typed, not checked against their values');
  else if (snap?.stale) console.error('sinter check: the content module changed since the collections\' snapshot (vite build or vite dev writes a new one): their values may be out of date');
  // content namespaces: their ids from the snapshot, so a page's calls are checked as the build checks them
  const ns = p.contentFile && snap ? snapshotNamespaces(root, p.helpers) : { helpers: p.helpers };
  const contentOpts = p.contentFile ? { contentModule: p.contentFile, ...(snap ? { collections: snap.collections } : {}), ...(ns.contentNs ? { contentNs: ns.contentNs } : {}) } : {};
  const lh = p.lazy.length ? lazyHelpers(root, p.lazy, undefined, p.libraries) : null;
  // the helpers module in Node, as the build loads it: what folds, and so SN322, agrees with the build
  const nh = await loadHelpers({ root, helpersFile: p.helpersFile, manifest: p.helpers });
  if (nh.error && p.helpersFile) diagnostics.push({ severity: 'warning', code: 'SN533', message: unloadedMessage(root, p.helpersFile, nh.error), file: p.helpersFile, line: 1, col: 1 });
  for (const file of files) {
    const out = compile(readFileSync(file, 'utf8'), { ...(lh ? { lazyModule: lh.reach } : {}), helperValues: nh.module, helperFold: nh.fold, ...contentOpts, file, root, dev: false, helpers: ns.helpers, actions: p.actions, config: p.config, readFile: p.readFile, listFiles: p.listFiles, check: true, openapi: p.openapi, apis: p.apis, complexity: p.complexity, ...(p.expansionLimit ? { expansionLimit: p.expansionLimit } : {}), componentNames: p.componentNames, libraries: p.libraries, lazy: p.lazy, ...(p.isStatic(file) ? { static: true, prerender: true } : {}), ...(p.swap ? { swap: true } : {}), ...(locale ? { locale } : {}) });
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
    const scripts = [...p.componentNames.filter((n) => !p.libraries.some((l) => l.public.includes(n))).map((n) => resolveFile(`/src/components/${n}.ts`, root, root) ?? resolveFile(`/src/components/${n}.js`, root, root)),
      ...p.libraries.flatMap((l) => [...l.public.map((n) => join(l.folder, 'components', n)), ...l.internal.map((n) => join(l.folder, 'components', 'internal', n))]).map((b) => componentScript(b + '.html'))].filter((f): f is string => !!f);
    diagnostics.push(...lazyDiagnostics(root, p.lazy, [p.helpersFile, p.actionsFile, mod(p.config), mod(p.early)], lh!.whole(p.helpers), scripts, p.libraries, p.helpersFile));
  }
  const r = check({ root, units, helpers: ns.helpers, actions: p.actions, types: p.types, openapi: p.openapi, messagesTypes: p.messagesTypes, libraries: p.libraries });
  diagnostics.push(...r.diagnostics);

  const warned = diagnostics.filter((d) => d.severity === 'warning').length;
  if (strict) diagnostics = applyStrict(diagnostics, allow);
  for (const d of diagnostics) console.log(formatDiagnostic({ ...d, file: relative(process.cwd(), d.file) || d.file }) + '\n');
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const promoted = warned - warnings;
  console.log(`sinter check${strict ? ' --strict' : ''}: ${files.length} page(s), ${errors} error(s)${promoted ? ` (${promoted} were warnings)` : ''}, ${warnings} warning(s); ${r.typed} of ${r.resources} resources typed${r.openapi ? ` (${r.openapi} via OpenAPI)` : ''}`);
  // agents check what a page shows in a browser they script themselves; `sinter render` answers that in one command
  const withData = units.find((u) => u.resources.length);
  if (withData) console.log(renderHint(relative(process.cwd(), withData.file) || withData.file, root));
  return errors ? 1 : 0;
}

/** The line `sinter check` ends with on a project whose pages load data: how to see one render with it. */
export function renderHint(page: string, root: string): string {
  let mocks = 'mocks.json';
  try { readFileSync(join(root, 'mocks.json')); } catch { mocks = 'mocks.json (routes such as { "GET /api/x": … })'; }
  return `to try a page and test what it does without a browser: npx sinter render ${page} --api http://localhost:<port> --click '<selector>' (your running API, or --api ${mocks}; prints the requests, the page and what each step changed; sinter render --help)`;
}

/** `sinter docs [topic]`: from the llms-full.txt (else llms.txt) and docs/diagnostics.md that ship beside dist/. */
async function docs(args: string[]): Promise<number> {
  const { lookup } = await import('./docs-cli.js');
  const pkg = new URL('..', import.meta.url);
  const read = (f: string) => { try { return readFileSync(new URL(f, pkg), 'utf8'); } catch { return ''; } };
  const r = lookup({ llms: read('llms-full.txt') || read('llms.txt'), diagnostics: read('docs/diagnostics.md') }, args.join(' ') || undefined);
  (r.found ? console.log : console.error)(r.text);
  return r.found ? 0 : 1;
}

/**
 * `sinter migrate [--root <dir>] [--write]`: every rename the compiler reports is applied to the pages,
 * components and layouts (`data-sn-prop` → `data-sn-with`, `refresh('people')` → `refresh(people)`, …);
 * with `sinter({ apis })`, their URLs also become paths relative to the APIs, and what to add to the config
 * is printed: the shapes every page agrees on, and the endpoints no API declares. Printed; written with `--write`.
 */
async function migrate(args: string[]): Promise<number> {
  let root = process.cwd(), write = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = resolve(args[++i] ?? '.');
    else if (args[i] === '--write') write = true;
    else { console.error(USAGE); return 2; }
  }
  const { migrateMarkup, configReport, formatReport, followUp, addQuery, removeAttributes, applyRenames } = await import('./migrate.js');
  const { pages, options } = await viteProject(root);
  // 0. the renames, until a pass finds none (a fix can uncover the next, as an old attribute inside an old one)
  {
    const p = project(root, options);
    const html = (dir: string) => { try { return readdirSync(join(root, dir)).filter((f) => f.endsWith('.html')).map((f) => join(root, dir, f)); } catch { return []; } };
    const files = new Set([...pages, ...html('src/components'), ...html('src/layouts')]);
    const texts = new Map<string, string>();
    const read = (f: string) => texts.get(f) ?? p.readFile(f);
    let total = 0;
    for (let pass = 0; pass < 5; pass++) {
      const diagnostics = pages.flatMap((file) => compile(read(file), { file, root, dev: false, helpers: p.helpers, actions: p.actions, config: p.config, readFile: read, listFiles: p.listFiles, openapi: p.openapi, apis: p.apis ?? undefined, componentNames: p.componentNames, libraries: p.libraries, lazy: p.lazy }).diagnostics);
      let n = 0;
      for (const file of files) {
        const r = applyRenames(read(file), diagnostics.filter((d) => d.file === file));
        if (!r.changes.length) continue;
        texts.set(file, r.text);
        n += r.changes.length;
        for (const c of r.changes) console.log(`${relative(root, file)}:${c.line}  ${c.from}  →  ${c.to}`);
      }
      total += n;
      if (!n) break;
    }
    if (write) for (const [file, text] of texts) writeFileSync(file, text);
    console.log(`sinter migrate: ${total} rename(s) in ${texts.size} file(s)${total && !write ? ' (run with --write to apply them)' : ''}`);
  }
  if (!options.apis) {
    const specs = options.openapi == null ? [] : ([] as string[]).concat(options.openapi);
    console.log('\nTo make the pages\' URLs paths of your APIs as well, configure them in the Vite config (docs/apis.md), then run it again:\n');
    console.log(`  sinter({ apis: { main: { ${specs.length ? `openapi: ${JSON.stringify(specs.length > 1 ? specs : specs[0])}` : "base: '/api'"} } } })\n`);
    if (specs.length) console.log('  (the base is the spec\'s first server; set `base` for another; remove the top-level `openapi`' + ((options as { origins?: string[] }).origins?.length ? ', and the API origins from `origins`)' : ')'));
    return 0;
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
  const diagnostics = pages.flatMap((file) => compile(read(file), { file, root, dev: false, helpers: p.helpers, actions: p.actions, config: p.config, readFile: read, listFiles: p.listFiles, openapi: p.openapi, apis: p.apis, componentNames: p.componentNames, libraries: p.libraries, lazy: p.lazy }).diagnostics);
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

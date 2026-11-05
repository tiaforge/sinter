#!/usr/bin/env node
// `sinter check [--root <dir>] [page.html …]`: compiles the pages and type-checks
// their expressions. Without pages, it reads them and the plugin options from the
// Vite config.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { check } from './check/index.js';
import { compile, formatDiagnostic, type CheckUnit, type Diagnostic } from './compiler/index.js';
import { project, type ProjectOptions } from './project.js';

const USAGE = 'usage: sinter check [--root <dir>] [page.html …]';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'check') {
    console.error(USAGE);
    return 2;
  }
  let root = process.cwd();
  const pages: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--root') root = resolve(rest[++i] ?? '.');
    else pages.push(rest[i]!);
  }
  let options: ProjectOptions = {};
  let files = pages.map((p) => resolve(root, p));
  if (!files.length) ({ files, options } = await fromVite(root));
  if (!files.length) {
    console.error(`sinter check: no pages found; pass them as arguments\n${USAGE}`);
    return 2;
  }

  const p = project(root, options);
  const diagnostics: Diagnostic[] = [];
  const units: CheckUnit[] = [];
  for (const file of files) {
    const out = compile(readFileSync(file, 'utf8'), { file, root, dev: false, helpers: p.helpers, config: p.config, readFile: p.readFile, check: true });
    diagnostics.push(...out.diagnostics);
    if (out.check) units.push(out.check);
  }
  const r = check({ root, units, helpers: p.helpers, types: p.types });
  diagnostics.push(...r.diagnostics);

  for (const d of diagnostics) console.log(formatDiagnostic({ ...d, file: relative(process.cwd(), d.file) || d.file }) + '\n');
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  console.log(`sinter check: ${files.length} page(s), ${errors} error(s), ${warnings} warning(s); ${r.typed} of ${r.resources} resources typed`);
  return errors ? 1 : 0;
}

/** HTML entries and sinter plugin options from the Vite config, if there is one. */
async function fromVite(root: string): Promise<{ files: string[]; options: ProjectOptions }> {
  let vite: typeof import('vite');
  try {
    vite = await import('vite');
  } catch {
    return { files: existsSync(resolve(root, 'index.html')) ? [resolve(root, 'index.html')] : [], options: {} };
  }
  const config = await vite.resolveConfig({ root, logLevel: 'silent' }, 'build', 'production');
  const plugin = config.plugins.find((x) => x.name === 'sinter') as { api?: { options?: ProjectOptions } } | undefined;
  const build = config.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } };
  const input = build.rolldownOptions?.input ?? build.rollupOptions?.input;
  const list = typeof input === 'string' ? [input] : Array.isArray(input) ? input : input && typeof input === 'object' ? Object.values(input) : [];
  let files = (list as string[]).filter((f) => typeof f === 'string' && f.endsWith('.html')).map((f) => resolve(config.root, f));
  if (!files.length && existsSync(resolve(config.root, 'index.html'))) files = [resolve(config.root, 'index.html')];
  return { files, options: plugin?.api?.options ?? {} };
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
  console.error(`sinter check: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});

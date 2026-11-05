// `sinter check`: type-checks every expression of the compiled pages with the
// project's own TypeScript (`tsc` on generated, checked JavaScript files).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { CheckUnit } from '../compiler/check-unit.js';
import type { HelperManifest } from '../compiler/compile.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { compile } from '../compiler/index.js';
import { project, type ProjectOptions } from '../project.js';
import type { OpenApiSpec } from '../compiler/openapi.js';
import { specDeclarations } from './openapi-types.js';
import { DECLARATIONS, mapPosition, shadow, type Region, type Shadow } from './shadow.js';

export interface CheckOptions {
  root: string;
  /** from `compile(…, { check: true })`, one per page */
  units: CheckUnit[];
  helpers: HelperManifest;
  /** absolute path of the types module, or null */
  types: string | null;
  /** the specs the pages were compiled with (`compile(…, { openapi })`) */
  openapi?: OpenApiSpec[];
  /** where the shadow files go (default `<root>/.sinter/check`) */
  outDir?: string;
  /** path of TypeScript's `tsc` script (default: resolved from the project) */
  tsc?: string;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  resources: number;
  /** resources with `type` or an OpenAPI match */
  typed: number;
  /** of those, typed from OpenAPI */
  openapi: number;
}

/** What every shadow file of a project refers to, written once per run. */
export interface Support {
  outDir: string;
  /** absolute path of `sinter.d.ts` */
  declarations: string;
  types: { file: string; names: string[] } | null;
  /** generated declarations per OpenAPI spec, by spec index */
  openapi: string[];
}

/** Writes `sinter.d.ts` and the spec declarations into `outDir`. */
export function writeSupport(o: { root: string; outDir: string; types: string | null; openapi?: OpenApiSpec[] }): Support {
  const declarations = join(o.outDir, 'sinter.d.ts');
  mkdirSync(o.outDir, { recursive: true });
  writeIfChanged(declarations, DECLARATIONS);
  const openapi = (o.openapi ?? []).map((s, i) => {
    const file = join(o.outDir, `openapi-${i}.d.ts`);
    writeIfChanged(file, specDeclarations(s.doc, relative(o.root, s.file).split('\\').join('/')));
    return file;
  });
  const types = o.types ? { file: o.types, names: typeExports(readFileSync(o.types, 'utf8')) } : null;
  return { outDir: o.outDir, declarations, types, openapi };
}

/** The compiler options shadow files are checked with. */
export const COMPILER_OPTIONS = {
  allowJs: true, checkJs: true, strict: true, strictNullChecks: false, noImplicitAny: false, noEmit: true, skipLibCheck: true,
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2023', 'dom', 'dom.iterable'], types: [] as string[],
};

/** Where a page's shadow file goes. */
export function shadowPath(support: Support, root: string, page: string): string {
  return join(support.outDir, relative(root, page) + '.js');
}

export function shadowOf(unit: CheckUnit, support: Support, root: string, helpers: HelperManifest): Shadow {
  return shadow({ unit, file: shadowPath(support, root, unit.file), root, declarations: support.declarations, types: support.types, helpers, openapi: support.openapi });
}

/** A TypeScript error at a 1-based shadow position, as an SN208 diagnostic at the HTML position. */
export function typeDiagnostic(unit: CheckUnit, regions: Region[], line: number, col: number, code: string, message: string, root: string): Diagnostic {
  const text = `${clean(message, root)} (${code})`;
  const loc = mapPosition(regions, line, col);
  return loc
    ? { severity: 'error', code: 'SN208', message: text + (loc.chain.length ? ` (included from ${loc.chain.join(' ← ')})` : ''), file: loc.file, line: loc.line, col: loc.col }
    : { severity: 'error', code: 'SN208', message: `in code sinter generated (please report): ${text}`, file: unit.file, line: 1, col: 1 };
}

function writeIfChanged(file: string, text: string): void {
  try { if (readFileSync(file, 'utf8') === text) return; } catch { /* missing */ }
  writeFileSync(file, text);
}

export function check(o: CheckOptions): CheckResult {
  const outDir = o.outDir ?? join(o.root, '.sinter', 'check');
  const support = writeSupport({ root: o.root, outDir, types: o.types, openapi: o.openapi });

  const shadows = new Map<string, { unit: CheckUnit; regions: Region[]; brokenFrom: number | null }>();
  for (const unit of o.units) {
    const file = shadowPath(support, o.root, unit.file);
    const s = shadowOf(unit, support, o.root, o.helpers);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, s.text);
    shadows.set(resolve(file), { unit, regions: s.regions, brokenFrom: s.brokenFrom });
  }
  const tsconfig = join(outDir, 'tsconfig.json');
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: COMPILER_OPTIONS,
    files: ['sinter.d.ts', ...support.openapi.map((f) => relative(outDir, f)), ...[...shadows.keys()].map((f) => relative(outDir, f).split('\\').join('/'))],
  }, null, 2) + '\n');

  const tsc = o.tsc ?? findTsc(o.root);
  const run = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], { encoding: 'utf8', cwd: outDir });
  if (run.error) throw run.error;
  const diagnostics = parseTsc(run.stdout, outDir, o.root, shadows);

  const resources = o.units.reduce((n, u) => n + u.resources.length, 0);
  const typed = o.units.reduce((n, u) => n + u.resources.filter((r) => r.type || r.openapi).length, 0);
  const viaOpenapi = o.units.reduce((n, u) => n + u.resources.filter((r) => !r.type && r.openapi).length, 0);
  return { diagnostics, resources, typed, openapi: viaOpenapi };
}

/**
 * Type-checks one page in a temporary project, for tests: `files` are written next to it
 * (`{ 'src/sinter.types.ts': … }`), options name them as in the Vite config. Returns the
 * compiler's and TypeScript's diagnostics; TypeScript is resolved from the current directory.
 */
export function checkPage(html: string, o: ProjectOptions & { files?: Record<string, string> } = {}): Diagnostic[] {
  const root = mkdtempSync(join(tmpdir(), 'sinter-check-page-'));
  try {
    for (const [rel, text] of Object.entries(o.files ?? {})) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const file = join(root, 'index.html');
    writeFileSync(file, html);
    const p = project(root, o);
    const out = compile(html, { file, root, dev: false, helpers: p.helpers, readFile: p.readFile, check: true, openapi: p.openapi });
    const r = check({ root, units: out.check ? [out.check] : [], helpers: p.helpers, types: p.types, openapi: p.openapi, tsc: findTsc(process.cwd()) });
    return [...p.diagnostics, ...out.diagnostics, ...r.diagnostics].map((d) => ({ ...d, file: relative(root, d.file) }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** TypeScript's `tsc` script, resolved from the project like its own imports. */
export function findTsc(root: string): string {
  const req = createRequire(join(root, 'package.json'));
  let pkg: string;
  try {
    pkg = req.resolve('typescript/package.json');
  } catch {
    throw new Error('sinter check needs TypeScript: npm install -D typescript');
  }
  const bin = (JSON.parse(readFileSync(pkg, 'utf8')) as { bin?: Record<string, string> }).bin?.tsc ?? 'bin/tsc';
  return join(dirname(pkg), bin);
}

/** Names a types module exports: TS declarations, `export { … }` lists and JSDoc typedefs. */
export function typeExports(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name);
    }
  }
  for (const m of source.matchAll(/@typedef\s+(?:\{.*?\}\s+)?([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  return [...names].sort();
}

/** `file(line,col): error TS1234: message`, with indented continuation lines. */
function parseTsc(stdout: string, outDir: string, root: string, shadows: Map<string, { unit: CheckUnit; regions: Region[]; brokenFrom: number | null }>): Diagnostic[] {
  const out: Diagnostic[] = [];
  let last: Diagnostic | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw);
    if (!m) {
      if (last && /^\s+\S/.test(raw)) last.message += '\n  ' + raw.trim();
      continue;
    }
    last = null;
    const s = shadows.get(resolve(outDir, m[1]!));
    // errors in the app's own modules are its own tsc's business; broken expressions are the compiler's
    if (!s || (s.brokenFrom !== null && Number(m[2]) >= s.brokenFrom)) continue;
    const d = typeDiagnostic(s.unit, s.regions, Number(m[2]), Number(m[3]), m[4]!, m[5]!, root);
    out.push(d);
    last = d;
  }
  return out;
}

/** Shortens absolute module paths in TypeScript's messages to project-relative ones. */
export function clean(message: string, root: string): string {
  return message.replace(/import\("([^"]+)"\)/g, (_, p: string) => `import("${p.startsWith(root) ? relative(root, p).split('\\').join('/') : p}")`);
}

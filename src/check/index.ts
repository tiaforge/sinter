// `sinter check`: type-checks every expression of the compiled pages with the
// project's own TypeScript (`tsc` on generated, checked JavaScript files).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import type { CheckUnit } from '../compiler/check-unit.js';
import type { HelperManifest } from '../compiler/compile.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import type { OpenApiSpec } from '../compiler/openapi.js';
import { specDeclarations } from './openapi-types.js';
import { DECLARATIONS, mapPosition, shadow, type Region } from './shadow.js';

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

export function check(o: CheckOptions): CheckResult {
  const outDir = o.outDir ?? join(o.root, '.sinter', 'check');
  const declarations = join(outDir, 'sinter.d.ts');
  const types = o.types ? { file: o.types, names: typeExports(readFileSync(o.types, 'utf8')) } : null;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(declarations, DECLARATIONS);

  const openapi = (o.openapi ?? []).map((s, i) => {
    const file = join(outDir, `openapi-${i}.d.ts`);
    writeFileSync(file, specDeclarations(s.doc, relative(o.root, s.file).split('\\').join('/')));
    return file;
  });

  const shadows = new Map<string, { unit: CheckUnit; regions: Region[] }>();
  for (const unit of o.units) {
    const file = join(outDir, relative(o.root, unit.file) + '.js');
    const s = shadow({ unit, file, root: o.root, declarations, types, helpers: o.helpers, openapi });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, s.text);
    shadows.set(resolve(file), { unit, regions: s.regions });
  }
  const tsconfig = join(outDir, 'tsconfig.json');
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: {
      allowJs: true, checkJs: true, strict: true, strictNullChecks: false, noImplicitAny: false, noEmit: true, skipLibCheck: true,
      target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2023', 'dom', 'dom.iterable'], types: [],
    },
    files: ['sinter.d.ts', ...openapi.map((f) => relative(outDir, f)), ...[...shadows.keys()].map((f) => relative(outDir, f).split('\\').join('/'))],
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
function parseTsc(stdout: string, outDir: string, root: string, shadows: Map<string, { unit: CheckUnit; regions: Region[] }>): Diagnostic[] {
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
    // errors in the app's own modules are its own tsc's business
    if (!s) continue;
    const message = `${clean(m[5]!, root)} (${m[4]})`;
    const loc = mapPosition(s.regions, Number(m[2]), Number(m[3]));
    const d: Diagnostic = loc
      ? { severity: 'error', code: 'SN208', message: message + (loc.chain.length ? ` (included from ${loc.chain.join(' ← ')})` : ''), file: loc.file, line: loc.line, col: loc.col }
      : { severity: 'error', code: 'SN208', message: `in code sinter generated (please report): ${message}`, file: s.unit.file, line: 1, col: 1 };
    out.push(d);
    last = d;
  }
  return out;
}

/** Shortens absolute module paths in TypeScript's messages to project-relative ones. */
function clean(message: string, root: string): string {
  return message.replace(/import\("([^"]+)"\)/g, (_, p: string) => `import("${p.startsWith(root) ? relative(root, p).split('\\').join('/') : p}")`);
}

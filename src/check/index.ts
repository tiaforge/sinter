// `sinter check`: type-checks every expression of the compiled pages with the
// project's own TypeScript (`tsc` on generated, checked JavaScript files).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { inlineScriptLang, inlineScriptModule, inlineScriptPath, inlineScripts } from '../compiler/components.js';
import { fileURLToPath } from 'node:url';
import type { CheckUnit } from '../compiler/check-unit.js';
import type { HelperManifest } from '../compiler/compile.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { compile } from '../compiler/index.js';
import { checkOptionsOf, compileOptionsOf, project, type ProjectOptions } from '../project.js';
import type { OpenApiSpec } from '../compiler/openapi.js';
import { specDeclarations, typeName } from './openapi-types.js';
import type { LibraryTypes } from './shadow.js';
import { DECLARATIONS, mapPosition, quietLine, shadow, type Region, type Shadow } from './shadow.js';

export interface CheckOptions {
  root: string;
  /** from `compile(…, { check: true })`, one per page */
  units: CheckUnit[];
  helpers: HelperManifest;
  /** the actions module (`data-sn-call`), same shape as helpers */
  actions?: HelperManifest;
  /** absolute path of the types module, or null */
  types: string | null;
  /** the specs the pages were compiled with (`compile(…, { openapi })`) */
  openapi?: OpenApiSpec[];
  /** where the shadow files go (default `<root>/.sinter/check`) */
  outDir?: string;
  /** path of TypeScript's `tsc` script (default: resolved from the project) */
  tsc?: string;
  /** the component libraries: type names in their components' props and slots resolve against each one's types module */
  libraries?: ReadonlyArray<{ folder: string; types: string | null }>;
  /** component files with a top-level `<script>`: their scripts are type-checked as if beside them (`scriptShadows`) */
  scripts?: string[];
  /** the generated `src/sinter.components.d.ts`, which types the base class a component's script imports from its HTML */
  componentTypes?: string | null;
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
  /** the component libraries' types modules, by the folder whose files they type */
  libraries?: LibraryTypes[];
  /** generated declarations per OpenAPI spec, by spec index */
  openapi: string[];
  /** the app's modules that declare its custom elements or their events (see `augmentations`) */
  augments: string[];
  /** the type names each spec declares (its named schemas), by spec index: a type the app writes may use them */
  schemas?: string[][];
}

/** Writes `sinter.d.ts` and the spec declarations into `outDir`. */
export function writeSupport(o: { root: string; outDir: string; types: string | null; openapi?: OpenApiSpec[]; libraries?: CheckOptions['libraries'] }): Support {
  const declarations = join(o.outDir, 'sinter.d.ts');
  mkdirSync(o.outDir, { recursive: true });
  // the app's own declarations of its elements and their events, wherever in src/ they are written
  const augments = augmentations(o.root);
  const refs = augments.map((f) => `/// <reference path="${relative(o.outDir, f).split('\\').join('/')}" />\n`).join('');
  writeIfChanged(declarations, refs + DECLARATIONS);
  const openapi = (o.openapi ?? []).map((s, i) => {
    const file = join(o.outDir, `openapi-${i}.d.ts`);
    writeIfChanged(file, specDeclarations(s.doc, relative(o.root, s.file).split('\\').join('/')));
    return file;
  });
  const types = o.types ? { file: o.types, names: typeExports(readFileSync(o.types, 'utf8')) } : null;
  const schemas = (o.openapi ?? []).map((s) => Object.keys((s.doc as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {}).map(typeName));
  const libraries = (o.libraries ?? []).flatMap((l) => (l.types ? [{ folder: l.folder, file: l.types, names: typeExports(readFileSync(l.types, 'utf8')) }] : []));
  return { outDir: o.outDir, declarations, types, openapi, augments, schemas, ...(libraries.length ? { libraries } : {}) };
}

/** The compiler options shadow files are checked with. */
export const COMPILER_OPTIONS = {
  allowJs: true, checkJs: true, strict: true, strictNullChecks: false, noImplicitAny: false, noEmit: true, skipLibCheck: true,
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', allowImportingTsExtensions: true, lib: ['es2023', 'dom', 'dom.iterable'], types: [] as string[],
};

/** Where a page's shadow file goes. */
export function shadowPath(support: Support, root: string, page: string): string {
  return join(support.outDir, relative(root, page) + '.js');
}

export function shadowOf(unit: CheckUnit, support: Support, root: string, helpers: HelperManifest, actions?: HelperManifest): Shadow {
  return shadow({ unit, file: shadowPath(support, root, unit.file), root, declarations: support.declarations, types: support.types, helpers, actions, openapi: support.openapi, ...(support.schemas ? { schemas: support.schemas } : {}), ...(support.libraries ? { libraries: support.libraries } : {}) });
}

/** A hint for a type error agents meet in markup, or null; \`tag\` is the element the expression sits on. */
export function typeHint(message: string, tag?: string): string | null {
  // `$event.target.value`: TypeScript types an event's target as any EventTarget
  const target = /Property '(\w+)' does not exist on type 'EventTarget'/.exec(message);
  if (!target) return null;
  // on the control itself, `$el` is it; on an ancestor (a form, a list), `$el` is the ancestor: a form even takes any
  // name (its fields by name), so `$el.value` would type-check and read the wrong thing
  if (tag && /^(input|select|textarea)$/i.test(tag)) {
    return `\`$event.target\` is any EventTarget to TypeScript: read the element the handler is on with \`$el.${target[1]}\` (typed by its tag), or bind the field with \`data-sn-model\``;
  }
  return `\`$event.target\` is any EventTarget to TypeScript, and here it is whatever the event started on inside this \`<${tag ?? 'element'}>\`: put the handler on that element (in a \`data-sn-for\` row, read the row's item instead of \`dataset\`), bind fields with \`data-sn-model\`, or narrow it: \`/** @type {HTMLInputElement} */ ($event.target).${target[1]}\``;
}

/** A TypeScript error at a 1-based shadow position, as an SN208 diagnostic at the HTML position. */
export function typeDiagnostic(unit: CheckUnit, regions: Region[], line: number, col: number, code: string, message: string, root: string): Diagnostic | null {
  const text = `${clean(message, root)} (${code})`;
  // a candidate of `<sn-component use>` whose key the branches around rule out: never chosen there
  const cand = regions.find((r) => r.candidate && line >= r.start && line < r.start + r.lines);
  if (cand) {
    if (code !== 'TS2367') return null;
    const c = cand.candidate!, at = cand.loc;
    return { severity: 'warning', code: 'SN538', message: `\`${c.name}\` can never be chosen here: \`${c.keySrc}\` cannot be \`${JSON.stringify(c.key)}\` where this \`<sn-component>\` is (a branch around it rules it out)` + (at.chain.length ? ` (included from ${at.chain.join(' ← ')})` : ''),
      file: at.file, line: at.line, col: at.col, hint: 'remove the candidate from `use`, or move the `<sn-component>` out of the branch that excludes it' };
  }
  const loc = mapPosition(regions, line, col);
  // the element the expression sits on (for the hint): the expression whose region holds the position
  const region = regions.find((r) => line >= r.start && line < r.start + r.lines);
  const expr = region && unit.exprs.find((e) => e.loc === region.loc || (e.loc.file === region.loc.file && e.loc.line === region.loc.line && e.loc.col === region.loc.col));
  const hint = typeHint(message, expr?.tag);
  return loc
    ? { severity: 'error', code: 'SN208', message: text + (loc.chain.length ? ` (included from ${loc.chain.join(' ← ')})` : ''), file: loc.file, line: loc.line, col: loc.col, ...(hint ? { hint } : {}) }
    : { severity: 'error', code: 'SN208', message: `in code sinter generated (please report): ${text}`, file: unit.file, line: 1, col: 1 };
}

/** What a page's types may need from the app besides the types module: the custom elements and their events. */
const AUGMENTS = /\binterface\s+(HTMLElementTagNameMap|SinterElementEvents)\b/;

/**
 * The app's modules under `src/` that declare custom elements for \`HTMLElementTagNameMap\` or their
 * events for \`SinterElementEvents\` (an island's class with \`declare global\`): \`$el\`, \`data-sn-with\`
 * and \`$event.detail\` are typed by them.
 */
export function augmentations(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        try { if (AUGMENTS.test(readFileSync(p, 'utf8'))) out.push(p); } catch { /* unreadable */ }
      }
    }
  };
  walk(join(root, 'src'));
  return out.sort();
}

function writeIfChanged(file: string, text: string): void {
  try { if (readFileSync(file, 'utf8') === text) return; } catch { /* missing */ }
  writeFileSync(file, text);
}

export function check(o: CheckOptions): CheckResult {
  const outDir = o.outDir ?? join(o.root, '.sinter', 'check');
  const support = writeSupport({ root: o.root, outDir, types: o.types, openapi: o.openapi, ...(o.libraries ? { libraries: o.libraries } : {}) });

  const shadows = new Map<string, { unit: CheckUnit; regions: Region[]; brokenFrom: number | null }>();
  for (const unit of o.units) {
    const file = shadowPath(support, o.root, unit.file);
    const s = shadowOf(unit, support, o.root, o.helpers, o.actions);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, s.text);
    shadows.set(resolve(file), { unit, regions: s.regions, brokenFrom: s.brokenFrom });
  }
  const scripts = writeScriptShadows(o.root, outDir, o.scripts ?? []);
  const tsconfig = join(outDir, 'tsconfig.json');
  const rel = (f: string) => relative(outDir, f).split('\\').join('/');
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: { ...COMPILER_OPTIONS, ...scriptOptions(o.root, outDir, scripts.size > 0) },
    // the types module always, so augmentations in it (declare global, a library's import type {}) apply
    files: ['sinter.d.ts', ...(support.types ? [rel(support.types.file)] : []), ...support.openapi.map((f) => relative(outDir, f)), ...[...shadows.keys()].map(rel),
      ...(scripts.size && o.componentTypes ? [rel(o.componentTypes)] : []), ...[...scripts.keys()].map(rel)],
  }, null, 2) + '\n');

  const tsc = o.tsc ?? findTsc(o.root);
  const run = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], { encoding: 'utf8', cwd: outDir });
  if (run.error) throw run.error;
  const diagnostics = parseTsc(run.stdout, outDir, o.root, shadows, scripts);

  const resources = o.units.reduce((n, u) => n + u.resources.length, 0);
  const typed = o.units.reduce((n, u) => n + u.resources.filter((r) => r.type || r.openapi || r.call || r.file?.adds || r.item || r.content).length, 0);
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
    const out = compile(html, { ...compileOptionsOf(p, file), file, dev: false, check: true });
    const r = check({ ...checkOptionsOf(p), units: out.check ? [out.check] : [], tsc: findTsc(process.cwd()) });
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
  // exports are read from the code without comments and strings; `@typedef`s from the comments
  const comments: string[] = [];
  const code = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g, (m) => {
    if (m[0] !== '/') return '""';
    comments.push(m);
    return ' ';
  });
  for (const m of code.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name);
    }
  }
  for (const m of comments.join('\n').matchAll(/@typedef\s+(?:\{.*?\}\s+)?([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  return [...names].sort();
}

/** `file(line,col): error TS1234: message`, with indented continuation lines. */
function parseTsc(stdout: string, outDir: string, root: string, shadows: Map<string, { unit: CheckUnit; regions: Region[]; brokenFrom: number | null }>, scripts: Map<string, string> = new Map()): Diagnostic[] {
  const out: Diagnostic[] = [];
  let last: Diagnostic | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw);
    if (!m) {
      if (last && /^\s+\S/.test(raw)) last.message += '\n  ' + raw.trim();
      continue;
    }
    last = null;
    // a component's top-level `<script>`: its shadow has the file's lines and columns
    const html = scripts.get(resolve(outDir, m[1]!));
    if (html) {
      last = { severity: 'error', code: 'SN208', message: `${clean(m[5]!, root)} (${m[4]})`, file: html, line: Number(m[2]), col: Number(m[3]) };
      out.push(last);
      continue;
    }
    const s = shadows.get(resolve(outDir, m[1]!));
    // errors in the app's own modules are its own tsc's business; broken expressions are the compiler's
    if (!s || (s.brokenFrom !== null && Number(m[2]) >= s.brokenFrom) || quietLine(s.regions, Number(m[2]))) continue;
    const d = typeDiagnostic(s.unit, s.regions, Number(m[2]), Number(m[3]), m[4]!, m[5]!, root);
    if (!d) continue;
    out.push(d);
    last = d;
  }
  return out;
}

/** Shortens absolute module paths in TypeScript's messages to project-relative ones. */
export function clean(message: string, root: string): string {
  return message.replace(/import\("([^"]+)"\)/g, (_, p: string) => `import("${p.startsWith(root) ? relative(root, p).split('\\').join('/') : p}")`);
}

/**
 * The shadow of a component's top-level `<script>`, in `outDir` at the component file's path inside the root
 * (`src/components/task-ring.html.script.ts`): its code at the file's lines and columns, so TypeScript's positions are the
 * file's. With `rootDirs` (`scriptOptions`), its relative imports resolve as from beside the component file.
 */
export function scriptShadowPath(root: string, outDir: string, html: string): string | null {
  const rel = relative(root, html);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  let text = '';
  try { text = readFileSync(html, 'utf8'); } catch { return null; }
  const s = inlineScripts(text)[0];
  return s ? join(outDir, inlineScriptPath(rel, inlineScriptLang(s.lang) ?? 'js')) : null;
}

/** Writes the shadows of the component files' scripts; shadow path → component file. */
export function writeScriptShadows(root: string, outDir: string, files: readonly string[], read: (f: string) => string = (f) => readFileSync(f, 'utf8')): Map<string, string> {
  const out = new Map<string, string>();
  for (const html of files) {
    let text: string;
    try { text = read(html); } catch { continue; }
    const m = inlineScriptModule(text, html);
    const s = inlineScripts(text)[0];
    const rel = relative(root, html);
    if (!m || !s || rel.startsWith('..') || isAbsolute(rel)) continue;
    const path = join(outDir, inlineScriptPath(rel, inlineScriptLang(s.lang) ?? 'js'));
    mkdirSync(dirname(path), { recursive: true });
    writeIfChanged(path, m.code);
    out.set(resolve(path), html);
  }
  return out;
}

/** The compiler options a component script's shadow needs: `rootDirs`, so `./x.js` beside it resolves in the root. */
export function scriptOptions(root: string, outDir: string, any: boolean): { rootDirs?: string[] } {
  return any ? { rootDirs: [relative(outDir, root).split('\\').join('/') || '.', '.'] } : {};
}

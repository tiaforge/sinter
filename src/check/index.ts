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
import { DECLARATIONS, mapPosition, quietLine, shadow, type Region, type Shadow, type ShadowOptions } from './shadow.js';
import { appTsconfig, SCRIPT_OVERRIDES, type AppTsconfig } from './tsconfig.js';

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
  /**
   * check each expression's function once where pages repeat it (a component's markup, used on many pages or many
   * times on one), and report its errors at every place it repeats (`checkShared`); the diagnostics are the same
   */
  share?: boolean;
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

/** The compiler options shadow files are checked with (`markupOptions` adds the app's `strictNullChecks`). */
export const COMPILER_OPTIONS = {
  allowJs: true, checkJs: true, strict: true, strictNullChecks: false, noImplicitAny: false, noEmit: true, skipLibCheck: true,
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', allowImportingTsExtensions: true, lib: ['es2023', 'dom', 'dom.iterable'], types: [] as string[],
};

/** The compiler options of the pages' shadows: sinter's, with the app's `strictNullChecks` when it has a tsconfig. */
export function markupOptions(app: AppTsconfig | null): typeof COMPILER_OPTIONS {
  return app ? { ...COMPILER_OPTIONS, strictNullChecks: app.strictNullChecks } : COMPILER_OPTIONS;
}

/** The folder of `outDir` the components' scripts' shadows go in, with their own tsconfig when the app has one. */
export const SCRIPTS_DIR = 'scripts';

/**
 * The tsconfig of the components' scripts' shadows (in `<outDir>/scripts`), for an app with a tsconfig: it extends
 * the app's, so a script is checked as the same code in a module beside its file would be, with sinter's
 * `SCRIPT_OVERRIDES`, `rootDirs` (`scriptOptions`) and its own files: the shadows, the components' generated types and
 * the app's declaration files (its globals).
 */
export function scriptTsconfig(app: AppTsconfig, root: string, dir: string, files: readonly string[] | { include: string[] }, componentTypes: string | null | undefined): string {
  const rel = (f: string) => { const r = relative(dir, f).split('\\').join('/'); return r.startsWith('.') ? r : './' + r; };
  const own = [...new Set([...(componentTypes ? [componentTypes] : []), ...app.declarations])].map(rel);
  return JSON.stringify({
    extends: rel(app.file),
    compilerOptions: { ...SCRIPT_OVERRIDES, ...scriptOptions(root, dir, true) },
    ...('include' in files ? { include: [...files.include, ...own] } : { include: [], files: [...new Set([...own, ...files.map(rel)])] }),
  }, null, 2) + '\n';
}

/** Where a page's shadow file goes. */
export function shadowPath(support: Support, root: string, page: string): string {
  return join(support.outDir, relative(root, page) + '.js');
}

export function shadowOf(unit: CheckUnit, support: Support, root: string, helpers: HelperManifest, actions?: HelperManifest, more: Partial<Pick<ShadowOptions, 'name' | 'unknown' | 'file'>> = {}): Shadow {
  return shadow({ unit, file: shadowPath(support, root, unit.file), root, declarations: support.declarations, types: support.types, helpers, actions, openapi: support.openapi, ...(support.schemas ? { schemas: support.schemas } : {}), ...(support.libraries ? { libraries: support.libraries } : {}), ...more });
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

  const tsc = o.tsc ?? findTsc(o.root);
  const app = appTsconfig(o.root, tsc);
  const scriptsDir = join(outDir, SCRIPTS_DIR);
  const scripts = writeScriptShadows(o.root, scriptsDir, o.scripts ?? []);
  // with the app's tsconfig, the scripts are a program of their own under its options (a second tsc, when there are any)
  const own = !!app && scripts.size > 0;
  /** writes the tsconfig(s) over these shadow files and runs `tsc` on each: the records of each run */
  const run = (files: string[]): TscRecord[][] => {
    const tsconfig = join(outDir, 'tsconfig.json');
    const rel = (f: string) => relative(outDir, f).split('\\').join('/');
    writeFileSync(tsconfig, JSON.stringify({
      compilerOptions: { ...markupOptions(app), ...(own ? {} : scriptOptions(o.root, scriptsDir, scripts.size > 0, outDir)) },
      // the types module always, so augmentations in it (declare global, a library's import type {}) apply
      files: ['sinter.d.ts', ...(support.types ? [rel(support.types.file)] : []), ...support.openapi.map((f) => relative(outDir, f)), ...files.map(rel),
        ...(!own && scripts.size && o.componentTypes ? [rel(o.componentTypes)] : []), ...(own ? [] : [...scripts.keys()].map(rel))],
    }, null, 2) + '\n');
    const runs = [tsconfig];
    if (own) {
      const t = join(scriptsDir, 'tsconfig.json');
      writeFileSync(t, scriptTsconfig(app, o.root, scriptsDir, [...scripts.keys()], o.componentTypes));
      runs.push(t);
    }
    return runs.map((t) => {
      const r = spawnSync(process.execPath, [tsc, '-p', t, '--pretty', 'false'], { encoding: 'utf8', cwd: outDir });
      if (r.error) throw r.error;
      return tscRecords(r.stdout, outDir);
    });
  };

  // (`SN_CHECK_SHARE=0`: every page checked whole, to compare)
  const diagnostics = (o.share && process.env.SN_CHECK_SHARE !== '0' ? checkShared(o, support, scripts, run) : null) ?? (() => {
    const shadows = new Map<string, ShadowInfo>();
    for (const unit of o.units) {
      const file = shadowPath(support, o.root, unit.file);
      const s = shadowOf(unit, support, o.root, o.helpers, o.actions);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, s.text);
      shadows.set(resolve(file), { unit, regions: s.regions, brokenFrom: s.brokenFrom });
    }
    return run([...shadows.keys()]).flatMap((records) => parseTsc(records, o.root, shadows, scripts));
  })();

  const resources = o.units.reduce((n, u) => n + u.resources.length, 0);
  const typed = o.units.reduce((n, u) => n + u.resources.filter((r) => r.type || r.openapi || r.call || r.file?.adds || r.item || r.content).length, 0);
  const viaOpenapi = o.units.reduce((n, u) => n + u.resources.filter((r) => !r.type && r.openapi).length, 0);
  return { diagnostics, resources, typed, openapi: viaOpenapi };
}

/** Expression `i`'s name in a shadow of the shared check, replaced when the shadow is written. */
const MARK = '\u0001';
const marked = (i: number) => `${MARK}${i}${MARK}`;
const MARKS = /\u0001(\d+)\u0001/g;
/** names a page's declarations give a type of its own (with its resources'): a function that reads one stays on the page */
const PAGE_NAMES = new Set(['$meta', 'refresh', 'upsert', 'page', '$A']);
const pageName = (t: string) => PAGE_NAMES.has(t) || /^\$(?:F\d|fv|O\d)/.test(t);
/** a name, anywhere in a function's text (its comments and strings too: a name read where it is not one only keeps the function on the page) */
const NAMES = /[A-Za-z_$][\w$]*/g;

/** Whether file names differ by case, as TypeScript tells (its order of files is by path, lower-cased where they do not). */
const caseSensitive = (() => {
  if (process.platform === 'win32') return false;
  const f = fileURLToPath(import.meta.url);
  const swapped = f.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  return swapped === f || !existsSync(swapped);
})();
/** TypeScript's order of the files of its diagnostics */
const pathOrder = (a: string, b: string) => {
  const p = (f: string) => { const x = f.split('\\').join('/'); return caseSensitive ? x : x.toLowerCase(); };
  const x = p(a), y = p(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The type check of many pages, each expression's function checked once. A page's shadow is a block of declarations
 * and a function per expression, which refers to nothing of the file but the declarations and the functions of the
 * frames it opens; a component's markup gives the same functions on every page and at every use, but for their names.
 * So the functions that repeat, with the functions they call, go once into a module of their own beside the pages
 * (one per folder, whose relative imports are theirs), and each page's shadow keeps the rest. TypeScript's errors in
 * a shared function are then laid out where each page would have had them, in the order TypeScript would have
 * printed them (by file, then position), and turned into diagnostics as before: the same, at every place it repeats.
 *
 * A function stays on its page when it reads a name the page's declarations type for that page (a resource, `$meta`,
 * `refresh`…), or calls one that does; the shared module's declarations are a page's without those. Null (check each
 * page whole) when nothing repeats, or when anything does not add up: an error outside a function of a shared module,
 * a message that names a shared function, files in an order other than expected.
 */
function checkShared(o: CheckOptions, support: Support, scripts: Map<string, string>, run: (files: string[]) => TscRecord[][]): Diagnostic[] | null {
  interface Ctx { dir: string; unknown: string[]; ids: Map<string, number>; texts: string[]; deps: number[][]; count: number[]; file?: string; at?: Int32Array; starts?: number[] }
  interface Page { unit: CheckUnit; file: string; sh: Shadow; ctx: Ctx; block: Array<{ text: string; deps: number[]; id: number | null }>; shared: boolean[] }
  // (`SN_CHECK_DEBUG=1`: what was shared, or why not)
  const debug = (s: string) => { if (process.env.SN_CHECK_DEBUG) process.stderr.write(`sinter check (shared): ${s}\n`); };
  const gaveUp = (why: string): null => { debug(`every page whole: ${why}`); return null; };
  const ctxs = new Map<string, Ctx>();
  const pages: Page[] = [];
  for (const unit of o.units) {
    const file = resolve(shadowPath(support, o.root, unit.file));
    if (/[^\x20-\x7e]/.test(file)) return gaveUp("a path TypeScript may order otherwise");
    const sh = shadowOf(unit, support, o.root, o.helpers, o.actions, { name: marked });
    const key = `${dirname(file)}\0${sh.unknown.join('\0')}`;
    let ctx = ctxs.get(key);
    if (!ctx) ctxs.set(key, ctx = { dir: dirname(file), unknown: sh.unknown, ids: new Map(), texts: [], deps: [], count: [] });
    const byExpr = new Map(sh.blocks.map((b, k) => [b.i, k]));
    const own = new Set(unit.resources.map((r) => r.name));
    // (a page whose markup holds the mark itself shares nothing)
    const clean = !JSON.stringify(unit).includes(MARK);
    const block = sh.blocks.map((b) => {
      const text = sh.lines.slice(b.start - 1, b.start - 1 + b.lines).join('\n');
      const deps = [...text.matchAll(MARKS)].map((m) => Number(m[1])).filter((j) => j !== b.i).map((j) => byExpr.get(j)!);
      return { text, deps, id: undefined as number | null | undefined };
    });
    /** the function's id in its folder's shared module, or null when it stays on the page */
    const idOf = (k: number): number | null => {
      const b = block[k]!;
      if (b.id !== undefined) return b.id;
      b.id = null;
      const e = unit.exprs[sh.blocks[k]!.i]!;
      if (!clean || e.broken || (b.text.replace(MARKS, ' ').match(NAMES) ?? []).some((t) => own.has(t) || pageName(t))) return null;
      const deps = b.deps.map(idOf);
      if (deps.some((d) => d === null)) return null;
      const i = sh.blocks[k]!.i;
      const text = b.text.replace(MARKS, (_, j: string) => (Number(j) === i ? '\u0002' : `$s${block[byExpr.get(Number(j))!]!.id}`));
      let id = ctx!.ids.get(text);
      if (id === undefined) {
        ctx!.ids.set(text, id = ctx!.texts.length);
        ctx!.texts.push(text);
        ctx!.deps.push(deps as number[]);
        ctx!.count.push(0);
      }
      ctx!.count[id]!++;
      return b.id = id;
    };
    block.forEach((_, k) => idOf(k));
    pages.push({ unit, file, sh, ctx, block: block as Page['block'], shared: [] });
  }
  // what repeats is taken from the shared module; what stays, with the functions it calls, is written on the page
  let any = false;
  for (const p of pages) {
    const local = p.block.map((b) => b.id === null || p.ctx.count[b.id]! < 2);
    const stack = local.flatMap((l, k) => (l ? [k] : []));
    while (stack.length) for (const d of p.block[stack.pop()!]!.deps) if (!local[d]) { local[d] = true; stack.push(d); }
    p.shared = local.map((l) => !l);
    any ||= p.shared.some(Boolean);
  }
  if (!any) return gaveUp("nothing repeats");

  // the shared modules: the functions pages take from them, and those they call
  let n = 0;
  for (const ctx of ctxs.values()) {
    const need = new Set<number>();
    const add = (id: number) => { if (need.has(id)) return; need.add(id); for (const d of ctx.deps[id]!) add(d); };
    for (const p of pages) if (p.ctx === ctx) p.block.forEach((b, k) => { if (p.shared[k]) add(b.id!); });
    if (!need.size) continue;
    ctx.file = join(ctx.dir, `$shared-${n++}.js`);
    const head = shadowOf({ file: ctx.file, resources: [], frames: [], exprs: [] }, support, o.root, o.helpers, o.actions, { file: ctx.file, unknown: ctx.unknown });
    const lines = head.lines.slice(0, head.prelude);
    ctx.starts = [];
    const at: number[] = [];
    for (const id of [...need].sort((a, b) => a - b)) {
      const own = ctx.texts[id]!.split('\u0002').join(`$s${id}`).split('\n');
      ctx.starts[id] = lines.length + 1;
      for (let k = 0; k < own.length; k++) at[lines.length + k + 1] = id;
      lines.push(...own);
    }
    ctx.at = Int32Array.from({ length: lines.length + 2 }, (_, l) => at[l] ?? -1);
    mkdirSync(ctx.dir, { recursive: true });
    writeFileSync(ctx.file, lines.join('\n') + '\n');
  }
  // the pages: their declarations and the functions they keep, each mapped back to its line in the page's whole shadow
  const real = new Map<string, { page: Page; virt: Int32Array }>();
  for (const p of pages) {
    const lines = p.sh.lines.slice(0, p.sh.prelude);
    const virt: number[] = Array.from({ length: p.sh.prelude + 1 }, (_, l) => l);
    p.sh.blocks.forEach((b, k) => {
      if (p.shared[k]) return;
      for (let l = 0; l < b.lines; l++) {
        virt[lines.length + 1] = b.start + l;
        lines.push(p.sh.lines[b.start - 1 + l]!.replace(MARKS, (_, j: string) => `$e${j}`));
      }
    });
    mkdirSync(dirname(p.file), { recursive: true });
    writeFileSync(p.file, lines.join('\n') + '\n');
    real.set(p.file, { page: p, virt: Int32Array.from(virt) });
  }
  const shared = new Map([...ctxs.values()].filter((c) => c.file).map((c) => [c.file!, c]));
  const [first = [], ...rest] = run([...real.keys(), ...shared.keys()]);

  // TypeScript prints its errors by file, then position: so must the files have come
  const order = [...new Set(first.map((r) => r.file))];
  if (order.some((f, k) => k > 0 && pathOrder(order[k - 1]!, f) >= 0)) return gaveUp("files in another order");
  const byId = new Map<Ctx, Map<number, TscRecord[]>>();
  const onPage = new Map<string, TscRecord[]>();
  const other = new Map<string, TscRecord[]>();
  for (const r of first) {
    const c = shared.get(r.file);
    if (c) {
      const id = c.at![r.line] ?? -1;
      if (id < 0 || /\$s\d/.test(r.message + r.more.join('\n'))) return gaveUp("an error outside a shared function, or naming one");
      let m = byId.get(c);
      if (!m) byId.set(c, m = new Map());
      let list = m.get(id);
      if (!list) m.set(id, list = []);
      list.push({ ...r, line: r.line - c.starts![id]! });
      continue;
    }
    const p = real.get(r.file);
    // (a line past the page's end: where would its whole shadow have had it)
    if (p && !(p.virt[r.line]! > 0)) return gaveUp("an error past a page's end");
    const list = (p ? onPage : other).get(r.file) ?? [];
    list.push(p ? { ...r, line: p.virt[r.line]! } : r);
    (p ? onPage : other).set(r.file, list);
  }
  // each page's errors as its whole shadow would have had them: its declarations', then each function's in turn
  const files = new Map<string, TscRecord[]>(other);
  const shadows = new Map<string, ShadowInfo>();
  for (const p of pages) {
    shadows.set(p.file, { unit: p.unit, regions: p.sh.regions, brokenFrom: p.sh.brokenFrom });
    const mine = onPage.get(p.file) ?? [];
    const out = mine.filter((r) => r.line <= p.sh.prelude);
    p.sh.blocks.forEach((b, k) => {
      if (!p.shared[k]) { for (const r of mine) if (r.line >= b.start && r.line < b.start + b.lines) out.push(r); return; }
      for (const r of byId.get(p.ctx)?.get(p.block[k]!.id!) ?? []) out.push({ ...r, file: p.file, line: b.start + r.line });
    });
    if (out.length) files.set(p.file, out);
  }
  const records = [...files.keys()].sort(pathOrder).flatMap((f) => files.get(f)!);
  if (process.env.SN_CHECK_DEBUG) {
    const all = pages.reduce((n, p) => n + p.block.length, 0), kept = pages.reduce((n, p) => n + p.shared.filter((s) => !s).length, 0);
    debug(`${pages.length} pages, ${all} functions: ${kept} on their pages, ${all - kept} from ${shared.size} shared module(s) of ${[...shared.values()].reduce((n, c) => n + c.starts!.filter((x) => x !== undefined).length, 0)} functions`);
  }
  return [records, ...rest].flatMap((rs) => parseTsc(rs, o.root, shadows, scripts));
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

/** A line of `tsc --pretty false`: `file(line,col): error TS1234: message`, with its indented continuation lines. */
interface TscRecord { file: string; line: number; col: number; code: string; message: string; more: string[] }

/** `tsc`'s output as records, in its order; `file` is absolute. */
function tscRecords(stdout: string, outDir: string): TscRecord[] {
  const out: TscRecord[] = [];
  let last: TscRecord | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw);
    if (!m) {
      if (last && /^\s+\S/.test(raw)) last.more.push(raw.trim());
      continue;
    }
    out.push(last = { file: resolve(outDir, m[1]!), line: Number(m[2]), col: Number(m[3]), code: m[4]!, message: m[5]!, more: [] });
  }
  return out;
}

type ShadowInfo = { unit: CheckUnit; regions: Region[]; brokenFrom: number | null };

/** The diagnostics of `tsc`'s records, in their order. */
function parseTsc(records: TscRecord[], root: string, shadows: Map<string, ShadowInfo>, scripts: Map<string, string> = new Map()): Diagnostic[] {
  const out: Diagnostic[] = [];
  const more = (d: Diagnostic, r: TscRecord) => { for (const x of r.more) d.message += '\n  ' + x; };
  for (const r of records) {
    // a component's top-level `<script>`: its shadow has the file's lines and columns
    const html = scripts.get(r.file);
    if (html) {
      const d: Diagnostic = { severity: 'error', code: 'SN208', message: `${clean(r.message, root)} (${r.code})`, file: html, line: r.line, col: r.col };
      more(d, r);
      out.push(d);
      continue;
    }
    const s = shadows.get(r.file);
    // errors in the app's own modules are its own tsc's business; broken expressions are the compiler's
    if (!s || (s.brokenFrom !== null && r.line >= s.brokenFrom) || quietLine(s.regions, r.line)) continue;
    const d = typeDiagnostic(s.unit, s.regions, r.line, r.col, r.code, r.message, root);
    if (!d) continue;
    more(d, r);
    out.push(d);
  }
  return out;
}

/** Shortens absolute module paths in TypeScript's messages to project-relative ones. */
export function clean(message: string, root: string): string {
  return message.replace(/import\("([^"]+)"\)/g, (_, p: string) => `import("${p.startsWith(root) ? relative(root, p).split('\\').join('/') : p}")`);
}

/**
 * The shadow of a component's top-level `<script>`, in `<outDir>/scripts` at the component file's path inside the root
 * (`scripts/src/components/task-ring.html.script.ts`): its code at the file's lines and columns, so TypeScript's positions are the
 * file's. With `rootDirs` (`scriptOptions`), its relative imports resolve as from beside the component file.
 */
export function scriptShadowPath(root: string, outDir: string, html: string): string | null {
  const rel = relative(root, html);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  let text = '';
  try { text = readFileSync(html, 'utf8'); } catch { return null; }
  const s = inlineScripts(text)[0];
  return s ? join(outDir, SCRIPTS_DIR, inlineScriptPath(rel, inlineScriptLang(s.lang) ?? 'js')) : null;
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
    writeIfChanged(path, scriptShadowText(m.code, path));
    out.set(resolve(path), html);
  }
  return out;
}

/**
 * A script shadow's text: the module's code, and a JS one checked by its own `// @ts-check` (on the first line, which
 * is padding when the script starts below it), whatever the app's `checkJs` says of its own modules.
 */
export function scriptShadowText(code: string, path: string): string {
  return /\.[cm]?js$/.test(path) && code.startsWith('\n') ? '// @ts-check' + code : code;
}

/**
 * The compiler options a component script's shadow needs: `rootDirs`, so `./x.js` beside it resolves in the root.
 * `dir` holds the shadows (`<outDir>/scripts`); `config` is the folder of the tsconfig the options go in (default `dir`).
 */
export function scriptOptions(root: string, dir: string, any: boolean, config: string = dir): { rootDirs?: string[] } {
  const rel = (f: string) => relative(config, f).split('\\').join('/') || '.';
  return any ? { rootDirs: [rel(root), rel(dir)] } : {};
}

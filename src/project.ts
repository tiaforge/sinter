// The app's conventional files (helpers, config, early and types modules), found the same
// way by the Vite plugin and by `sinter check`.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { readHelperManifest, type Diagnostic, type HelperManifest } from './compiler/index.js';
import type { OpenApiSpec } from './compiler/openapi.js';
import { resolveApis, type ApiOptions, type ApisDef } from './compiler/apis.js';
import { COMPLEXITY_LIMITS, type ComplexityOptions } from './compiler/complexity.js';
import { MESSAGES_MODULE, messagesDts, readMessages, type MessagesProject } from './i18n-build.js';
import { componentNames, writeComponentTypes } from './components-build.js';

export interface ProjectOptions {
  /** helpers module, relative to the root (default `src/sinter.helpers.js`, or `.ts`) */
  helpers?: string;
  /** actions module for `data-sn-call` and `<sn-resource call>` (default `src/sinter.actions.js`, or `.ts`) */
  actions?: string;
  /** app configuration module imported before mount (default `src/sinter.config.js`, or `.ts`) */
  config?: string;
  /** app module the early chunk runs before the first paint (default `src/sinter.early.js`, or `.ts`) */
  early?: string;
  /**
   * built-in messages: the inlang project (default `project.inlang`, if it exists) whose message
   * files give `m.key()` in markup and `m` from `@tiaforge-ui/sinter/messages`; `false`: none
   */
  messages?: string | false;
  /** module whose exported types `type="…"` on `<sn-resource>` may name (default `src/sinter.types.ts`, `.d.ts` or `.js`) */
  types?: string;
  /** OpenAPI specs (JSON or YAML, inside the root) that resources without `type` are matched against; deprecated: give each API its spec in `apis` */
  openapi?: string | string[];
  /**
   * The APIs the app calls (docs/apis.md): base URL, OpenAPI spec, request settings, and what each
   * endpoint returns. A path on a page (`src="/contacts"`, `data-sn-delete="billing:/invoices/{i.id}"`)
   * is relative to one of them, and must be an operation it declares.
   */
  apis?: Record<string, ApiOptions>;
  /** the API a path without `api:` goes to; with one API configured it is that one */
  defaultApi?: string;
  /** SN507: limits for expressions too complex for markup (`statements`, `sequences`, `guarded`, `ternaries`, `arrow`, `operations`) and `level`: `warn` (default), `error` or `off` */
  complexity?: ComplexityOptions;
  /** SN509: report `then`/`catch` handlers that start each other again through `run()`, in the build, `sinter check` and `sinter lsp` (default off; `sinter check --check-cycles` for one run) */
  checkCycles?: boolean;
  /**
   * SN322: pages that must ship no JavaScript, by their paths relative to the root (`'about.html'`,
   * `'docs/**'`; `*` within one folder, `**` across folders), or `true` for every page. A matched page
   * that needs the runtime fails the build, `sinter check` and the editor; a pattern no page matches too.
   */
  static?: string[] | true;
  /**
   * Packages loaded on first call instead of with the page (docs/lazy.md): every import of one in the
   * app's modules gets async stubs that share one `import()`, so the package is a chunk of its own.
   * Only awaited calls of its exports work (SN324); component scripts that import it load with it.
   */
  lazy?: string[];
}

/** A path pattern of `static`: `**` any folders, `*` within one name, `?` one character. */
export function staticPattern(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') { re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += pattern[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Whether `file` must ship no JavaScript (`static`), and the patterns no page of `pages` matches. */
export function staticPages(root: string, option: ProjectOptions['static']) {
  const rel = (f: string) => relative(root, f).split(sep).join('/');
  const list = option === true ? null : (option ?? []).map((p) => ({ p, re: staticPattern(p.replace(/^\.\//, '')) }));
  return {
    has: (file: string) => list === null || list.some((x) => x.re.test(rel(file))),
    unmatched: (pages: string[]) => (list ?? []).filter((x) => !pages.some((f) => x.re.test(rel(f)))).map((x) => x.p),
  };
}

export interface Project {
  root: string;
  helpers: HelperManifest;
  /** absolute path of the helpers module, or null */
  helpersFile: string | null;
  /** the actions module's functions and namespaces (same shape as helpers) */
  actions: HelperManifest;
  /** absolute path of the actions module, or null */
  actionsFile: string | null;
  /** root-relative URL of the config module (`/src/sinter.config.js`), or null */
  config: string | null;
  /** root-relative URL of the early module (`/src/sinter.early.ts`), or null */
  early: string | null;
  /** the built-in messages, or null without an inlang project */
  messages: MessagesProject | null;
  /** the generated `src/sinter.messages.d.ts` (written when there are messages), or null */
  messagesTypes: string | null;
  /** the generated `src/sinter.components.d.ts` (written when a component has a script), or null */
  componentsTypes: string | null;
  /** absolute path of the types module, or null */
  types: string | null;
  /** reads a file only if it resolves inside the root, symlinks included */
  readFile: (path: string) => string;
  openapi: OpenApiSpec[];
  /** `apis`, resolved (their specs are in `openapi`), or null without `apis` */
  apis: ApisDef | null;
  /** problems loading the specs (SN307) and the APIs (SN329) */
  diagnostics: Diagnostic[];
  /** every component of the app (`src/components/<name>.html`): `ComponentName`, the candidates of `<sn-component use>` */
  componentNames: string[];
  /** the `complexity` option, checked */
  complexity: ComplexityOptions;
  checkCycles: boolean;
  /** `static`: the pages that must ship no JavaScript (SN322) */
  isStatic: (file: string) => boolean;
  /** `lazy`: the packages loaded on first call (docs/lazy.md) */
  lazy: string[];
}

export function project(root: string, options: ProjectOptions = {}): Project {
  const find = (given: string | undefined, base: string, exts = ['.js', '.ts']): string | null => {
    const candidates = given ? [given] : exts.map((e) => base + e);
    for (const c of candidates) if (existsSync(resolve(root, c))) return c;
    return null;
  };
  const readFile = (path: string): string => {
    const real = realpathSync(path);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`outside the project root: ${path}`);
    return readFileSync(real, 'utf8');
  };
  const url = (rel: string) => '/' + rel.split(sep).join('/');

  const manifest = (given: string | undefined, base: string): [HelperManifest, string | null] => {
    const rel = find(given, base);
    const file = rel ? resolve(root, rel) : null;
    if (!rel || !file) return [{ module: null, names: [], namespaces: {} }, null];
    return [readHelperManifest(readFileSync(file, 'utf8'), {
      module: url(rel),
      file,
      readFile,
      resolve: (spec, from) => {
        if (!spec.startsWith('.')) return null;
        const b = resolve(dirname(from), spec);
        for (const q of [b, b.replace(/\.js$/, '.ts'), `${b}.js`, `${b}.ts`]) if (existsSync(q)) return q;
        return null;
      },
    }), file];
  };
  const [helpers, helpersFile] = manifest(options.helpers, 'src/sinter.helpers');
  const [actions, actionsFile] = manifest(options.actions, 'src/sinter.actions');
  const configRel = find(options.config, 'src/sinter.config');
  const earlyRel = find(options.early, 'src/sinter.early');
  const typesRel = find(options.types, 'src/sinter.types', ['.ts', '.d.ts', '.js']);
  const openapi: OpenApiSpec[] = [];
  const diagnostics: Diagnostic[] = [];
  const loadSpec = (rel: string): number | null => {
    const file = resolve(root, rel);
    const fail = (why: string) => { diagnostics.push({ severity: 'error', code: 'SN307', message: `OpenAPI spec \`${rel}\` ${why}`, file, line: 1, col: 1 }); return null; };
    let text: string;
    try { text = readFile(file); } catch (e) { return fail(`cannot be read: ${(e as Error).message}`); }
    let doc: unknown;
    try { doc = /\.json$/i.test(file) ? JSON.parse(text) : (createRequire(import.meta.url)('yaml') as typeof import('yaml')).parse(text); } catch (e) {
      return fail(`is not valid ${/\.json$/i.test(file) ? 'JSON' : 'YAML'}: ${(e as Error).message.split('\n')[0]}`);
    }
    const d = doc as { openapi?: unknown; paths?: unknown } | null;
    if (!d || typeof d.openapi !== 'string' || !/^3\./.test(d.openapi) || typeof d.paths !== 'object') return fail('is not an OpenAPI 3 document (needs `openapi: 3.x` and `paths`)');
    openapi.push({ file, doc });
    return openapi.length - 1;
  };
  const listOf = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  let apis: ApisDef | null = null;
  if (options.apis != null) {
    const configFile = resolve(root, VITE_CONFIGS.find((f) => existsSync(resolve(root, f))) ?? 'vite.config.js');
    const r = resolveApis(options, (rel) => (typeof rel === 'string' ? loadSpec(rel) : null), openapi, configFile);
    diagnostics.push(...r.diagnostics);
    apis = r.apis;
  } else {
    for (const rel of listOf(options.openapi)) loadSpec(rel);
  }
  // built-in messages: `m` is theirs, typed by a generated declaration file
  const messages = options.messages === false ? null : readMessages(root, options.messages ?? 'project.inlang');
  let messagesTypes: string | null = null;
  if (messages) {
    diagnostics.push(...messages.diagnostics);
    if (helpers.namespaces.m && helpers.namespaces.m.module !== MESSAGES_MODULE) {
      diagnostics.push({ severity: 'error', code: 'SN307', message: 'the helpers module exports a namespace `m`, and the inlang project gives sinter\'s built-in `m`: remove the re-export (`export * as m from …`)', file: helpersFile ?? root, line: 1, col: 1 });
    }
    helpers.namespaces.m = { module: MESSAGES_MODULE, members: Object.keys(messages.keys).sort() };
    messagesTypes = resolve(root, 'src/sinter.messages.d.ts');
    const text = messagesDts(messages);
    let current = '';
    try { current = readFileSync(messagesTypes, 'utf8'); } catch { /* missing */ }
    if (current !== text) { mkdirSync(dirname(messagesTypes), { recursive: true }); writeFileSync(messagesTypes, text); }
  }
  return {
    root, helpers, helpersFile, actions, actionsFile, readFile, openapi, apis, diagnostics, complexity: complexityOf(options.complexity), checkCycles: !!options.checkCycles,
    isStatic: staticPages(root, options.static).has,
    lazy: lazyOf(options.lazy),
    componentNames: componentNames(root),
    messages, messagesTypes, componentsTypes: writeComponentTypes(root, readFile),
    config: configRel ? url(configRel) : null,
    early: earlyRel ? url(earlyRel) : null,
    types: typesRel ? resolve(root, typesRel) : null,
  };
}

/**
 * The pages (HTML entries) and sinter plugin options from the root's Vite config. Without
 * Vite or entries, `index.html` if it exists.
 */
export async function viteProject(root: string): Promise<{ pages: string[]; options: ProjectOptions }> {
  const fallback = () => (existsSync(resolve(root, 'index.html')) ? [resolve(root, 'index.html')] : []);
  let vite: typeof import('vite');
  try {
    vite = await import('vite');
  } catch {
    return { pages: fallback(), options: {} };
  }
  const config = await vite.resolveConfig({ root, logLevel: 'silent' }, 'build', 'production');
  const plugin = config.plugins.find((x) => x.name === 'sinter') as { api?: { options?: ProjectOptions } } | undefined;
  const build = config.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } };
  const input = build.rolldownOptions?.input ?? build.rollupOptions?.input;
  const list = typeof input === 'string' ? [input] : Array.isArray(input) ? input : input && typeof input === 'object' ? Object.values(input) : [];
  let pages = (list as string[]).filter((f) => typeof f === 'string' && f.endsWith('.html')).map((f) => resolve(config.root, f));
  if (!pages.length) pages = fallback();
  return { pages, options: plugin?.api?.options ?? {} };
}

/** The `complexity` option, refused when it names an unknown limit or level, or a limit is not a number of 0 or more. */
export function complexityOf(c: ComplexityOptions | undefined): ComplexityOptions {
  if (c == null) return {};
  const bad = (m: string) => { throw new Error(`sinter: complexity: ${m}`); };
  if (typeof c !== 'object') bad('takes an object, e.g. `{ statements: 4, level: \'warn\' }`');
  for (const [k, v] of Object.entries(c)) {
    if (k === 'level') { if (!['warn', 'error', 'off'].includes(v as string)) bad(`\`level\` is \`warn\`, \`error\` or \`off\`, not \`${String(v)}\``); }
    else if (!(COMPLEXITY_LIMITS as string[]).includes(k)) bad(`\`${k}\` is not a limit; the limits are ${COMPLEXITY_LIMITS.map((l) => `\`${l}\``).join(', ')}`);
    else if (typeof v !== 'number' || !(v >= 0)) bad(`\`${k}\` takes a number of 0 or more`);
  }
  return c;
}

/** The `lazy` option, checked: package names (`openpgp`, `@scope/pkg`), not paths. */
export function lazyOf(list: unknown): string[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('sinter({ lazy }): takes a list of package names, e.g. `lazy: [\'openpgp\']`');
  for (const x of list) {
    if (typeof x !== 'string' || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(x)) throw new Error(`sinter({ lazy }): \`${String(x)}\` is not a package name; list packages from node_modules, e.g. \`'openpgp'\` (a subpath such as \`openpgp/lightweight\` is covered by its package)`);
  }
  return [...new Set(list as string[])];
}

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'];

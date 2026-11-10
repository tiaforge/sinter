// The app's conventional files (helpers, config, early and types modules), found the same
// way by the Vite plugin and by `sinter check`.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { readHelperManifest, type Diagnostic, type HelperManifest } from './compiler/index.js';
import type { OpenApiSpec } from './compiler/openapi.js';
import { COMPLEXITY_LIMITS, type ComplexityOptions } from './compiler/complexity.js';
import { MESSAGES_MODULE, messagesDts, readMessages, type MessagesProject } from './i18n-build.js';
import { writeComponentTypes } from './components-build.js';

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
  /** OpenAPI specs (JSON or YAML, inside the root) that resources without `type` are matched against */
  openapi?: string | string[];
  /** SN507: limits for expressions too complex for markup (`statements`, `sequences`, `guarded`, `ternaries`, `arrow`, `operations`) and `level`: `warn` (default), `error` or `off` */
  complexity?: ComplexityOptions;
  /** SN509: report `then`/`catch` handlers that start each other again through `run()`, in the build, `sinter check` and `sinter lsp` (default off; `sinter check --check-cycles` for one run) */
  checkCycles?: boolean;
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
  /** problems loading the specs (SN307) */
  diagnostics: Diagnostic[];
  /** the `complexity` option, checked */
  complexity: ComplexityOptions;
  checkCycles: boolean;
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
  for (const rel of options.openapi == null ? [] : Array.isArray(options.openapi) ? options.openapi : [options.openapi]) {
    const file = resolve(root, rel);
    const fail = (why: string) => diagnostics.push({ severity: 'error', code: 'SN307', message: `OpenAPI spec \`${rel}\` ${why}`, file, line: 1, col: 1 });
    let text: string;
    try { text = readFile(file); } catch (e) { fail(`cannot be read: ${(e as Error).message}`); continue; }
    let doc: unknown;
    try { doc = /\.json$/i.test(file) ? JSON.parse(text) : (createRequire(import.meta.url)('yaml') as typeof import('yaml')).parse(text); } catch (e) {
      fail(`is not valid ${/\.json$/i.test(file) ? 'JSON' : 'YAML'}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    const d = doc as { openapi?: unknown; paths?: unknown } | null;
    if (!d || typeof d.openapi !== 'string' || !/^3\./.test(d.openapi) || typeof d.paths !== 'object') {
      fail('is not an OpenAPI 3 document (needs `openapi: 3.x` and `paths`)');
      continue;
    }
    openapi.push({ file, doc });
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
    root, helpers, helpersFile, actions, actionsFile, readFile, openapi, diagnostics, complexity: complexityOf(options.complexity), checkCycles: !!options.checkCycles,
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

// The content module in Node (docs/resources.md#collections): loaded before any page compiles, its collections run once
// each, concurrently (one that `get`s another waits for it), and their results checked: a list of plain data, each
// entry with a unique key. The compile stays synchronous: it reads the lists from here as constants, as it reads a
// `file:` source's value. Failing here fails the build; the dev server keeps going and reports it on the pages that
// read a collection.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { isCollection, type Collection, type CollectionContext, type Languages } from './content.js';
import { fileEntry, filePath } from './compiler/files.js';
import { importModule, type LoadOptions } from './helpers-node.js';

/** what a build's compiles read: each collection's list and key, by its export's name */
export type Collections = Map<string, { key: string; value: readonly unknown[] }>;

export interface LoadedContent {
  /** the collections every language shares */
  collections: Collections;
  /** with languages: each language's `perLocale` collections */
  perLocale: Map<string, Collections>;
  /** why the module or a collection failed (each line one problem), or null */
  error: string | null;
  /** the files the loaders read through `ctx.files`: a change in one runs them again (dev) */
  files: string[];
  /** the module's `languages()` export, if it has one */
  languages: Languages | null;
  /**
   * `per` collections (docs/proposals/axes.md §3): for each, the collections it is loaded per (by name) and its list at
   * each combination of their entries' keys (joined by `\0`, in `per`'s order)
   */
  perPoint: PerPoint;
  /** content namespaces (`namespace()`): by the export's name, the name pages call it by and its formatter module */
  namespaces: Map<string, { name: string; format: string; type?: string }>;
}

export type PerPoint = Map<string, { key: string; per: string[]; values: Map<string, readonly unknown[]> }>;

export interface ContentOptions extends Omit<LoadOptions, 'helpersFile' | 'manifest' | 'cache'> {
  /** the content module, absolute */
  file: string;
  command: 'build' | 'serve';
  /** the project's reads (inside the root, links refused) and its listing of a folder (no `node_modules`, no dot-folders) */
  readFile: (path: string) => string;
  listFiles: (dir: string) => string[];
  /** the variables loaders get as `ctx.env` (Vite's `loadEnv`) */
  env: Record<string, string>;
  /**
   * with `localePrefix`: the languages a `perLocale` collection is loaded for, when the module declares none
   * (`languages()`); a function, so the inlang project is read only when needed
   */
  locales?: readonly string[] | (() => readonly string[]);
}

/** a compile's collections in a language: the shared ones, and that language's own */
export function collectionsIn(c: LoadedContent, locale: string | undefined): Collections {
  const own = locale ? c.perLocale.get(locale) : undefined;
  return own?.size ? new Map([...c.collections, ...own]) : c.collections;
}

/** Loads the content module and runs its collections. Never throws: a failure is `error`. */
export async function loadContent(o: ContentOptions): Promise<LoadedContent> {
  const collections: Collections = new Map(), perLocale = new Map<string, Collections>(), files = new Set<string>();
  const rel = (f: string) => relative(o.root, f).split(sep).join('/');
  let mod: Record<string, unknown>;
  try { mod = await importModule(o, o.file); } catch (e) {
    return { collections, perLocale, error: scrub(`the content module could not be loaded (${rel(o.file)}): ${String((e as Error)?.message ?? e).split('\n')[0]}`, o.env), files: [], languages: null, perPoint: new Map(), namespaces: new Map() };
  }
  const problems: string[] = [];
  const names = new Map<Collection, string>();
  for (const [name, v] of Object.entries(mod)) {
    if (name === 'default') { problems.push(`${rel(o.file)}: a default export is not a collection; export each collection by its name (\`export const posts = collection({ … })\`)`); continue; }
    if (!isCollection(v)) { problems.push(`${rel(o.file)}: \`${name}\` is exported but not a collection; the content module exports only collections (\`collection({ key, load })\`), and helpers go in the helpers module`); continue; }
    names.set(v, name);
  }
  const declared = [...names].filter(([c]) => c.languages);
  if (declared.length > 1) problems.push(`${rel(o.file)}: \`${declared.map(([, n]) => n).join('`, `')}\` are each \`languages()\`; the site has one list of languages`);
  const languages = declared[0]?.[0].languages ?? null;
  // one run per collection, and per language for a `perLocale` one: `get` shares it, whoever asks
  const running = new Map<string, Promise<unknown[]>>();
  const run = (c: Collection, chain: string[], locale: string | undefined): Promise<unknown[]> => {
    const name = names.get(c) ?? '(a collection the content module does not export)';
    if (chain.includes(name)) return Promise.reject(new Error(`collections get each other in a cycle: ${[...chain, name].join(' → ')}`));
    const at = c.perLocale ? locale : undefined;
    const k = `${name}\0${at ?? ''}`;
    let p = running.get(k);
    if (!p) {
      const ctx: CollectionContext = {
        files: (async (glob: string, opts?: { drafts?: string }) => readGlob(o, glob, opts?.drafts ?? null, files)) as CollectionContext['files'],
        get: (other) => {
          const oc = other as Collection;
          // a list every language shares cannot be built from one that differs per language
          if (oc.perLocale && !c.perLocale) return Promise.reject(new Error(`it gets \`${names.get(oc) ?? 'a collection'}\`, which is loaded per language (\`perLocale\`): make it \`perLocale: true\` too`)) as never;
          return run(oc, [...chain, name], at) as never;
        },
        env: o.env,
        command: o.command,
        root: o.root,
        locale: at,
        value: () => undefined,
      };
      p = Promise.resolve().then(() => c.load(ctx)).then((v) => checked(v, name, c.key));
      running.set(k, p);
    }
    return p;
  };
  // the languages a `perLocale` collection is loaded for: the module's own, else the given ones (read when one needs them)
  let given: readonly string[] | null = null;
  const langsOf = (): readonly string[] => languages?.list ?? (given ??= typeof o.locales === 'function' ? o.locales() : o.locales ?? []);
  await Promise.all([...names].filter(([c]) => !c.per).map(async ([c, name]) => {
    try {
      if (!c.perLocale) { collections.set(name, { key: c.key, value: await run(c, [], undefined) }); return; }
      const langs = langsOf();
      if (!langs.length) throw new Error('it is loaded per language (`perLocale: true`), and the site has none: `perLocale` needs `sinter({ localePrefix })`');
      for (const l of langs) {
        const value = await run(c, [], l);
        if (!perLocale.has(l)) perLocale.set(l, new Map());
        perLocale.get(l)!.set(name, { key: c.key, value });
      }
    } catch (e) {
      problems.push(`collection \`${name}\`: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
    }
  }));
  // `per` collections: once per combination of their lists' entries (each list loaded above, every language's own for a
  // `perLocale` one: a `per` collection's lists are read in the base language)
  const perPoint: PerPoint = new Map();
  for (const [c, name] of names) {
    if (!c.per) continue;
    try {
      const lists = c.per.map((x) => {
        const n = names.get(x as Collection);
        if (!n) throw new Error('it is loaded per a collection the content module does not export');
        if ((x as Collection).per) throw new Error(`it is loaded per \`${n}\`, which is loaded per collections itself`);
        const got = collections.get(n) ?? perLocale.get(langsOf()[0] ?? '')?.get(n);
        if (!got) throw new Error(`it is loaded per \`${n}\`, which did not load`);
        return { c: x as Collection, n, key: got.key, entries: got.value };
      });
      const values = new Map<string, readonly unknown[]>();
      const walk = async (i: number, at: unknown[]) => {
        if (i === lists.length) {
          const ctx: CollectionContext = {
            files: (async (glob: string, opts?: { drafts?: string }) => readGlob(o, glob, opts?.drafts ?? null, files)) as CollectionContext['files'],
            get: (other) => run(other as Collection, [name], undefined) as never,
            env: o.env, command: o.command, root: o.root,
            // a `languages()` list among `per`: its entry's tag is the run's language
            locale: lists.map((l, j) => (l.c.languages ? (at[j] as { tag: string }).tag : undefined)).find(Boolean),
            value: ((x: Collection) => { const j = lists.findIndex((l) => l.c === x); return j < 0 ? undefined : at[j]; }) as CollectionContext['value'],
          };
          values.set(lists.map((l, j) => String((at[j] as Record<string, unknown>)?.[l.key])).join('\0'), checked(await c.load(ctx), name, c.key));
          return;
        }
        for (const e of lists[i]!.entries) await walk(i + 1, [...at, e]);
      };
      await walk(0, []);
      perPoint.set(name, { key: c.key, per: lists.map((l) => l.n), values });
    } catch (e) {
      problems.push(`collection \`${name}\`: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
    }
  }
  const namespaces = new Map<string, { name: string; format: string; type?: string }>();
  for (const [c, n] of names) {
    if (!c.namespace) continue;
    // its type, from the base language's entries (the first point's, for one loaded per axis)
    let type: string | undefined;
    const base = collections.get(n)?.value ?? perLocale.get(langsOf()[0] ?? '')?.get(n)?.value ?? [...(perPoint.get(n)?.values.values() ?? [])][0];
    if (c.namespace.types && base) { try { type = c.namespace.types([...base]); } catch (e) { problems.push(`namespace \`${n}\`: its types: ${String((e as Error)?.message ?? e).split('\n')[0]}`); } }
    namespaces.set(n, { name: c.namespace.name, format: c.namespace.format, ...(type ? { type } : {}) });
  }
  const named = new Map<string, string>();
  for (const [n, d] of namespaces) {
    if (named.has(d.name)) problems.push(`\`${named.get(d.name)}\` and \`${n}\` are both the namespace \`${d.name}\`: a name calls one namespace`);
    named.set(d.name, n);
  }
  return { collections, perLocale, error: problems.length ? scrub(problems.join('\n'), o.env) : null, files: [...files].sort(), languages, perPoint, namespaces };
}

/**
 * A loader's error without its secrets: it is printed, and in dev shown in the page's overlay. URLs lose their
 * credentials and query (`?token=…`), and the values of `ctx.env` longer than a few characters are masked.
 */
export function scrub(message: string, env: Record<string, string>): string {
  let m = message.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, '$1').replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s?#'"]*)\?[^\s#'"]*/gi, '$1?…');
  for (const v of Object.values(env).filter((x) => x.length >= 8).sort((a, b) => b.length - a.length)) m = m.split(v).join('***');
  return m;
}

/** `ctx.files(glob)`: the files as a `file:` glob reads them, from the project root */
function readGlob(o: ContentOptions, glob: string, drafts: string | null, read: Set<string>): Array<Record<string, unknown>> {
  const where = filePath(`file:/${glob.replace(/^\.?\//, '')}`, `${o.root}/x`, o.root);
  if ('error' in where) throw new Error(`files(${JSON.stringify(glob)}): ${where.error}`);
  if (!where.glob) throw new Error(`files(${JSON.stringify(glob)}): not a glob; for one file, read it yourself, or use \`file:\` on the page`);
  const { dir, match } = where.glob, base = dir.replace(/\/$/, '');
  let listed: string[];
  try { listed = o.listFiles(dir); } catch { listed = []; }
  const out: Array<Record<string, unknown>> = [];
  for (const f of listed.filter((x) => x.startsWith(base + '/') && match.test(x.slice(base.length + 1))).sort()) {
    read.add(f);
    const e = fileEntry(o.readFile(f), f, dir, o.root);
    if ('error' in e) throw new Error(`files(${JSON.stringify(glob)}): ${e.error}`);
    if (drafts && o.command === 'build' && e.value[drafts] === true) continue;
    out.push(e.value);
  }
  return out;
}

/** a loader's result: a list of plain data with a unique key per entry, frozen at every depth */
function checked(v: unknown, name: string, key: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`its loader returned ${v === null ? 'null' : typeof v}, not a list`);
  const seen = new Map<unknown, number>();
  v.forEach((e, i) => {
    const bad = notPlain(e);
    if (bad) throw new Error(`entry ${i} is not plain data: ${bad}`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`entry ${i} is not an object`);
    const k = (e as Record<string, unknown>)[key];
    if (typeof k !== 'string' && typeof k !== 'number') throw new Error(`entry ${i} has no \`${key}\` (its key, a string or a number)`);
    const prev = seen.get(k);
    if (prev !== undefined) throw new Error(`entries ${prev} and ${i} have one \`${key}\`, \`${String(k)}\``);
    seen.set(k, i);
  });
  return freeze(v);
}

/** what is not plain data in a value, or null: a `Date`, a `Map`, a class, a function */
function notPlain(v: unknown, path = ''): string | null {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : `\`${path || 'it'}\` is ${String(v)}`;
  if (Array.isArray(v)) { for (const [i, x] of v.entries()) { const b = notPlain(x, `${path}[${i}]`); if (b) return b; } return null; }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return `\`${path || 'it'}\` is a ${(v as object).constructor?.name ?? 'class instance'}${v instanceof Date ? ' (return `toISOString()`)' : ''}`;
    for (const [k, x] of Object.entries(v)) { const b = notPlain(x, path ? `${path}.${k}` : k); if (b) return b; }
    return null;
  }
  return `\`${path || 'it'}\` is a ${typeof v}`;
}

function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) freeze(x); }
  return v;
}

/**
 * The snapshot `sinter check` and the editor compile against (they never run loaders: a CMS fetch per keystroke or
 * per CI check would be slow, need secrets and depend on the network). The build and the dev server write it each
 * time they load the collections.
 */
export const snapshotFile = (root: string) => join(root, 'node_modules/.cache/sinter/content.json');

export function writeSnapshot(root: string, file: string, c: LoadedContent, baseLocale?: string): void {
  try {
    const out = snapshotFile(root);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ version: 1, module: relative(root, file).split(sep).join('/'), mtimeMs: statSync(file).mtimeMs, collections: { ...Object.fromEntries(collectionsIn(c, baseLocale)), ...Object.fromEntries([...(c.perPoint ?? new Map())].map(([n, p]) => [n, { key: p.key, value: [...p.values.values()][0] ?? [] }])) }, ...(c.namespaces?.size ? { namespaces: Object.fromEntries(c.namespaces) } : {}), ...(c.languages ? { languages: c.languages } : {}) }));
  } catch { /* a cache: the check goes without it */ }
}

/**
 * The content namespaces the last snapshot recorded, for `sinter check` and the editor (which run no loaders): the
 * helpers manifest with each one in it (its ids its members), and the compile's `contentNs` (the base language's
 * entries; no formatter in Node, so nothing folds)
 */
export function snapshotNamespaces<H extends { namespaces: Record<string, { module: string; members: string[] }> }>(root: string, helpers: H): { helpers: H; contentNs?: Record<string, { entries: Record<string, unknown>; format: string | null }> } {
  try {
    const s = JSON.parse(readFileSync(snapshotFile(root), 'utf8')) as { version: number; collections: Record<string, { key: string; value: Array<Record<string, unknown>> }>; namespaces?: Record<string, { name: string; format: string; type?: string }> };
    if (s.version !== 1 || !s.namespaces) return { helpers };
    const namespaces = { ...helpers.namespaces }, contentNs: Record<string, { entries: Record<string, unknown>; format: string | null }> = {};
    for (const [exp, d] of Object.entries(s.namespaces)) {
      if (namespaces[d.name]) continue;
      const l = s.collections[exp], entries: Record<string, unknown> = {};
      for (const e of l?.value ?? []) entries[String(e[l!.key])] = e;
      namespaces[d.name] = { module: `sinter:content/${d.name}`, members: Object.keys(entries).sort(), ...(d.type ? { type: d.type } : {}) };
      contentNs[d.name] = { entries, format: d.format };
    }
    return { helpers: { ...helpers, namespaces }, contentNs };
  } catch { return { helpers }; }
}

/** The languages the last snapshot's content module declared (`languages()`), or null. */
export function snapshotLanguages(root: string): Languages | null {
  try {
    const s = JSON.parse(readFileSync(snapshotFile(root), 'utf8')) as { version: number; languages?: Languages };
    return s.version === 1 && s.languages ? s.languages : null;
  } catch { return null; }
}

/** The last snapshot, and whether the content module changed since (`stale`), or null when there is none. */
export function readSnapshot(root: string, file: string): { collections: Collections; stale: boolean } | null {
  try {
    const s = JSON.parse(readFileSync(snapshotFile(root), 'utf8')) as { version: number; mtimeMs: number; collections: Record<string, { key: string; value: unknown[] }> };
    if (s.version !== 1) return null;
    return { collections: new Map(Object.entries(s.collections)), stale: statSync(file).mtimeMs > s.mtimeMs };
  } catch { return null; }
}

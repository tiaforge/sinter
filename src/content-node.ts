// The content module in Node (docs/resources.md#collections): loaded before any page compiles, its collections run once
// each, concurrently (one that `get`s another waits for it), and their results checked: a list of plain data, each
// entry with a unique key. The compile stays synchronous: it reads the lists from here as constants, as it reads a
// `file:` source's value. Failing here fails the build; the dev server keeps going and reports it on the pages that
// read a collection.
import { relative, sep } from 'node:path';
import { isCollection, type Collection, type CollectionContext } from './content.js';
import { fileEntry, filePath } from './compiler/files.js';
import { importModule, type LoadOptions } from './helpers-node.js';

/** what a build's compiles read: each collection's list and key, by its export's name */
export type Collections = Map<string, { key: string; value: readonly unknown[] }>;

export interface LoadedContent {
  collections: Collections;
  /** why the module or a collection failed (each line one problem), or null */
  error: string | null;
  /** the files the loaders read through `ctx.files`: a change in one runs them again (dev) */
  files: string[];
}

export interface ContentOptions extends Omit<LoadOptions, 'helpersFile' | 'manifest' | 'cache'> {
  /** the content module, absolute */
  file: string;
  command: 'build' | 'serve';
  /** the project's reads (inside the root, links refused) and its listing of a folder (no `node_modules`, no dot-folders) */
  readFile: (path: string) => string;
  listFiles: (dir: string) => string[];
  /** the variables loaders get as `ctx.env` (Vite's `loadEnv`) */
  env: Record<string, string>;
}

/** Loads the content module and runs its collections. Never throws: a failure is `error`. */
export async function loadContent(o: ContentOptions): Promise<LoadedContent> {
  const collections: Collections = new Map(), files = new Set<string>();
  const rel = (f: string) => relative(o.root, f).split(sep).join('/');
  let mod: Record<string, unknown>;
  try { mod = await importModule(o, o.file); } catch (e) {
    return { collections, error: scrub(`the content module could not be loaded (${rel(o.file)}): ${String((e as Error)?.message ?? e).split('\n')[0]}`, o.env), files: [] };
  }
  const problems: string[] = [];
  const names = new Map<Collection, string>();
  for (const [name, v] of Object.entries(mod)) {
    if (name === 'default') { problems.push(`${rel(o.file)}: a default export is not a collection; export each collection by its name (\`export const posts = collection({ … })\`)`); continue; }
    if (!isCollection(v)) { problems.push(`${rel(o.file)}: \`${name}\` is exported but not a collection; the content module exports only collections (\`collection({ key, load })\`), and helpers go in the helpers module`); continue; }
    names.set(v, name);
  }
  const running = new Map<Collection, Promise<unknown[]>>();
  const run = (c: Collection, chain: string[]): Promise<unknown[]> => {
    const name = names.get(c) ?? '(a collection the content module does not export)';
    if (chain.includes(name)) return Promise.reject(new Error(`collections get each other in a cycle: ${[...chain, name].join(' → ')}`));
    let p = running.get(c);
    if (!p) {
      const ctx: CollectionContext = {
        files: (async (glob: string, opts?: { drafts?: string }) => readGlob(o, glob, opts?.drafts ?? null, files)) as CollectionContext['files'],
        get: (other) => run(other as Collection, [...chain, name]) as never,
        env: o.env,
        command: o.command,
      };
      p = Promise.resolve().then(() => c.load(ctx)).then((v) => checked(v, name, c.key));
      running.set(c, p);
    }
    return p;
  };
  await Promise.all([...names].map(async ([c, name]) => {
    try { collections.set(name, { key: c.key, value: await run(c, []) }); } catch (e) {
      problems.push(`collection \`${name}\`: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
    }
  }));
  return { collections, error: problems.length ? scrub(problems.join('\n'), o.env) : null, files: [...files].sort() };
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

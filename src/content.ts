// Collections (docs/resources.md#collections): build-time lists from code, declared in the app's content module
// (`src/sinter.content.ts`) and read by pages as `<sn-resource src="content:posts">`. A collection is a loader the
// build runs once, in Node, before any page compiles: it may fetch a CMS, read files and use secrets, and its result
// is a constant of the pages that read it, as a `file:` source's value is. This module is what the app imports; the
// build's side (loading the module, running the loaders, checking their results) is `content-node.ts`.

/** marks a collection, across instances of this module (the app's and the build's may differ) */
export const COLLECTION = Symbol.for('sinter.collection');

/** a `file:` entry, as `ctx.files` reads it: the file's own fields, and the ones sinter writes */
export type FileEntry<T = Record<string, unknown>> = T & { slug: string; dir: string; path: string; body?: string };

export interface CollectionContext {
  /**
   * The files a glob matches (from the project root: `content/posts/*.md`), as a `file:` glob reads them: each a
   * markdown file's frontmatter and `body`, a JSON file's object, or a text file's `body`, with `slug`, `dir` and
   * `path`, sorted by path. `drafts` names a field: an entry where it is `true` is left out of a build.
   */
  files<T = Record<string, unknown>>(glob: string, options?: { drafts?: string }): Promise<Array<FileEntry<T>>>;
  /** another collection's list, loaded once whichever collections ask */
  get<T>(c: Collection<T>): Promise<T[]>;
  /** the variables of Vite's `loadEnv`: `.env`, `.env.<mode>` and the process's, every prefix */
  env: Record<string, string>;
  /** `'build'` in `vite build`, `'serve'` in `vite dev` */
  command: 'build' | 'serve';
  /** the project's root, absolute (a loader that reads its own files: `inlang()`) */
  root: string;
  /** with `perLocale: true` (and `localePrefix`): the language this run loads for; else undefined */
  locale: string | undefined;
  /**
   * with `per`: the entry of each of those collections this run loads for (`value(tenants)` is a tenant), or undefined
   * for a collection that is not in `per`
   */
  value<T>(c: Collection<T>): T | undefined;
}

export interface Collection<T = unknown> {
  readonly [COLLECTION]: true;
  /** the field that tells entries apart: the resource's `key`, unique in the list */
  readonly key: string;
  readonly load: (ctx: CollectionContext) => T[] | Promise<T[]>;
  /** loaded once per language (`ctx.locale`), each language's pages reading its own list */
  readonly perLocale?: true;
  /**
   * loaded once per entry of each of these collections (docs/proposals/axes.md §3), the axes' lists of the pages that
   * read it (`per: [tenants]`): each page reads the list of its own tenant
   */
  readonly per?: readonly Collection[];
  /** `languages()`: the site's languages, which `localePrefix` builds every page in (docs/static-pages.md#languages) */
  readonly languages?: Languages;
  /** `namespace()`: the name a page calls its entries by, and its formatter module */
  readonly namespace?: { readonly name: string; readonly format: string };
}

/** The site's languages: `base`, where a visitor without a choice lands, and every language in `list`. */
export interface Languages { readonly base: string; readonly list: readonly string[]; readonly fallbacks?: Readonly<Record<string, readonly string[]>> }

/** one of the site's languages, as `languages()` lists them: its BCP 47 tag */
export interface Language { tag: string }

/** a language tag as a URL's first segment takes it (`de`, `de-AT`, `zh-Hant-TW`) */
export const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * A collection: `key` names the field that tells entries apart, and `load` returns the list, a list of plain data
 * (arrays, objects, strings, numbers, booleans, `null`).
 */
export function collection<T>(o: { key: keyof T & string; load: (ctx: CollectionContext) => T[] | Promise<T[]>; perLocale?: boolean; per?: readonly Collection<any>[] }): Collection<T> {
  if (!o || typeof o.key !== 'string' || !o.key) throw new Error('collection(): `key` names the field that tells entries apart, e.g. `collection({ key: \'slug\', load })`');
  if (typeof o.load !== 'function') throw new Error('collection(): `load` is a function that returns the list, e.g. `load: async () => (await fetch(url)).json()`');
  if (o.per !== undefined && (!Array.isArray(o.per) || !o.per.length || !o.per.every(isCollection))) throw new Error('collection(): `per` lists the collections it is loaded for, each an axis\'s list (`per: [tenants]`)');
  return { [COLLECTION]: true, key: o.key, load: o.load, ...(o.perLocale ? { perLocale: true as const } : {}), ...(o.per ? { per: [...o.per] } : {}) };
}

/**
 * The site's languages (docs/static-pages.md#languages), exported from the content module:
 * `export const locales = languages({ base: 'en', list: ['en', 'de'] })`. With `localePrefix`, every page is built
 * once per language, under its prefix (`/de/about/`). It is a collection of `{ tag }`, one entry per language. Without
 * it, the languages come from the inlang project of the built-in messages.
 */
export function languages(o: { base: string; list: readonly string[]; fallbacks?: Record<string, readonly string[]> }): Collection<Language> {
  const list = Array.isArray(o?.list) ? [...o.list] : null;
  if (!list?.length) throw new Error("languages(): `list` names the site's languages, e.g. `languages({ base: 'en', list: ['en', 'de'] })`");
  for (const l of list) if (typeof l !== 'string' || !LANGUAGE_TAG.test(l)) throw new Error(`languages(): \`${String(l)}\` in \`list\` is not a language tag (it becomes the URL's prefix, \`/${String(l)}/\`)`);
  const dup = list.find((l, i) => list.indexOf(l) !== i);
  if (dup) throw new Error(`languages(): \`${dup}\` is in \`list\` twice`);
  if (typeof o.base !== 'string' || !list.includes(o.base)) throw new Error(`languages(): \`base\` (${typeof o.base === 'string' ? `\`${o.base}\`` : 'missing'}) is one of \`list\` (${list.join(', ')}): it is the language a visitor without a choice is sent to`);
  // `fallbacks`: a language's chain before the base, where it is not its tag less its subtags (docs/static-pages.md#languages)
  const fb = o.fallbacks;
  if (fb !== undefined) {
    if (!fb || typeof fb !== 'object' || Array.isArray(fb)) throw new Error("languages(): `fallbacks` maps a language to the ones it falls back to before the base, e.g. `{ 'de-CH': ['de-AT', 'de'] }`");
    for (const [k, v] of Object.entries(fb)) {
      if (!list.includes(k)) throw new Error(`languages(): \`fallbacks\` names \`${k}\`, which is not one of \`list\` (${list.join(', ')})`);
      if (!Array.isArray(v) || v.some((x) => !list.includes(x) || x === k)) throw new Error(`languages(): \`fallbacks.${k}\` is a list of the other languages of \`list\` (${list.join(', ')})`);
      for (const x of v) if (fb[x]?.includes(k)) throw new Error(`languages(): \`fallbacks.${k}\` and \`fallbacks.${x}\` name each other: a chain has no cycle`);
    }
  }
  return { [COLLECTION]: true, key: 'tag', load: () => list.map((tag) => ({ tag })), languages: { base: o.base, list, ...(fb ? { fallbacks: Object.fromEntries(Object.entries(fb).map(([k, v]) => [k, [...v]])) } : {}) } };
}

/**
 * A content namespace (docs/proposals/messages.md §1): a collection whose entries a page calls by their key,
 * `legal.imprint()`, `legal.terms({ shop: tenant.name })`, each through the formatter module's
 * `format(entry, args, locale)`. A call over constants is written into the HTML at build; one over data is compiled
 * into the page's script with that entry alone. Each page ships only the entries it calls. `format` is a module
 * path from the root (`/src/legal-format.ts`) or a package; `key` (default `id`) names an entry's id field.
 */
export function namespace<T>(o: { name: string; format: string; key?: keyof T & string; load: (ctx: CollectionContext) => T[] | Promise<T[]>; perLocale?: boolean }): Collection<T> {
  if (!o || typeof o.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(o.name)) throw new Error("namespace(): `name` is what a page calls its entries by, an identifier, e.g. `namespace({ name: 'legal', format, load })`");
  if (typeof o.format !== 'string' || !o.format) throw new Error("namespace(): `format` names the formatter module, whose `format(entry, args, locale)` makes an entry's value, e.g. `format: '/src/legal-format.ts'`");
  const c = collection<T>({ key: (o.key ?? 'id') as keyof T & string, load: o.load, ...(o.perLocale ? { perLocale: true } : {}) });
  return { ...c, namespace: { name: o.name, format: o.format } };
}

/** whether a value is a collection (of any instance of this module) */
export function isCollection(v: unknown): v is Collection {
  return !!v && typeof v === 'object' && (v as Record<symbol, unknown>)[COLLECTION] === true;
}

/**
 * A list in pages of `size` entries, for an index in pages (`<html data-sn-for="p in postPages">` at `/blog/page/:n`):
 * each page's number `n` (from 1), its `items`, and the number of pages, `count`.
 */
export function chunks<T>(list: readonly T[], size: number): Array<{ n: number; items: T[]; count: number }> {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunks(): \`size\` is a whole number of 1 or more (it is ${String(size)})`);
  const count = Math.max(1, Math.ceil(list.length / size));
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, items: list.slice(i * size, (i + 1) * size), count }));
}

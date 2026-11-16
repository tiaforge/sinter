// The `file:` source (docs/resources.md#files): `<sn-resource src="file:./post.md">` reads the repository at build
// time, one file or, with a glob, a list of them. A file's value is its text, a `.json` file's parsed value, and a
// markdown file's frontmatter with its `body`; a glob's value is a list of entries, one per file, each with its `slug`,
// `dir` and `path`. It is a constant: nothing loads, refreshes or writes it. What the browser still reads reaches it
// as embedded data in the head (not a placeholder a server fills). What needs no compiler state is here; `compile.ts`
// calls it from `fileResource()`.
import { normalize } from 'node:path/posix';
import { isAlias, isMap, parseDocument, visit } from 'yaml';

/** the built-in name of the source in `src` (beside `site`), and so a reserved API name */
export const FILE = 'file';

/** whether a `src` (or an action's URL) is a `file:` source */
export const isFileSource = (value: string | undefined) => value != null && /^file:/.test(value.trimStart());

/** the attributes a `file:` resource takes: the others load, refresh, page or write it */
export const FILE_ATTRS = ['name', 'src', 'type', 'items', 'key', 'order', 'drafts'];

const ATTR_LIST = '`name`, `src`, `type`, `items`, `key`, `order` and `drafts`';

/** Why an attribute of `<sn-resource>` does not apply to a `file:` resource. */
export function fileAttrProblem(name: string): string {
  const what: Record<string, string> = {
    refresh: 'reloads', cache: 'caches responses', paginate: 'loads pages', each: 'sends a request per item', call: 'runs an action function',
    when: 'decides when to load', then: 'runs after a load', early: 'decides how it is requested', method: 'sends a request', body: 'sends a request body',
    total: 'reads a total from a response',
  };
  const why = what[name] ?? (/^(page-size|size-param|cursor|direction-param|direction-values|page-param|offset-param|page-model)$/.test(name) ? 'pages a list' : null);
  return why
    ? `\`${name}\` ${why}, and a \`file:\` resource is a constant: it is read at build time and never loads or changes; it takes only \`name\`, \`type\`, \`items\` and \`key\``
    : `\`${name}\` is not an attribute of a \`file:\` resource, which takes only \`name\`, \`type\`, \`items\` and \`key\``;
}

/** the built-in name of the content module's collections in `src` (`content:posts`), and so a reserved API name */
export const CONTENT = 'content';

/** whether a `src` is a collection of the content module: `content:` and a name (not a path: `content:/x` is not one) */
export const isContentSource = (value: string | undefined) => value != null && /^content:[A-Za-z_$]/.test(value.trimStart());

/** the attribute of the internal resource that holds a `data-sn-pages` entry (never written by a page) */
export const PAGE_ENTRY = 'data-sn-page-entry';

/** whether a `file:` path is a glob: `*`, `**`, `?`, or `{a,b}` alternation */
export const isGlob = (rel: string) => /[*?]|\{[^{}]*,[^{}]*\}/.test(rel);

/**
 * The file a `file:` source names, or with a glob the folder it lists (its fixed part) and what the paths below it must
 * match: a literal path, relative to the file that wrote it (a page, a layout, a component), or `/…` from the project
 * root, and inside the root. Paths are `/`-separated.
 */
export function filePath(value: string, from: string, root: string): { path: string; glob?: { dir: string; match: RegExp } } | { error: string } {
  const rel = value.trim().slice('file:'.length);
  // `{a,b}` is a glob's alternation; any other brace would be a value of the page's data
  if (/\{(?![^{}]*,[^{}]*\})/.test(rel)) return { error: 'a `file:` path is a literal: an interpolation (`{…}`) would make the page depend on data; for a list of files, use a glob (`file:./posts/*.md`)' };
  if (!rel) return { error: '`file:` needs a path: `file:./post.md`, `file:/content/post.md` from the project root, or a glob such as `file:/content/posts/*.md`' };
  if (/[?#]/.test(rel.replace(/\?/g, isGlob(rel) ? '' : '?'))) return { error: 'a `file:` path takes no query or fragment' };
  const top = normalize(root.replace(/\\/g, '/')).replace(/\/$/, '');
  const dir = from.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const path = normalize(rel.startsWith('/') ? `${top}${rel}` : `${dir}/${rel}`);
  if (!path.startsWith(top + '/')) return { error: `\`${rel}\` is outside the project root: a \`file:\` source reads the project's own files` };
  if (!isGlob(rel)) return { path };
  // the fixed part: the folders before the first segment with a glob character
  const parts = path.split('/'), at = parts.findIndex((x) => isGlob(x) || x.includes('*') || x.includes('?'));
  const base = parts.slice(0, at).join('/') || '/';
  return { path, glob: { dir: base, match: globRegExp(parts.slice(at).join('/')) } };
}

/** A glob, below its fixed part, as a regular expression over the paths below it: `**` any folders, `*` within one name. */
export function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:[^/]+/)*' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
/** the fields sinter writes into an entry: an entry of the files' own with one of these names is an error */
const RESERVED = ['body', 'dir', 'path'];

/**
 * A markdown file's frontmatter (YAML between `---` lines at its start) and its `body`. The schema is YAML's core one,
 * so dates stay strings (`2026-11-16`) and `yes` is a string; anchors, aliases and tags are refused, since they make the
 * file's data depend on YAML's features rather than its text.
 */
export function frontmatter(text: string): { value: Record<string, unknown> } | { error: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { value: { body: text } };
  const doc = parseDocument(m[1]!, { schema: 'core', uniqueKeys: true });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) return { error: `its frontmatter is not valid YAML: ${problem.message.split('\n')[0]}` };
  let refused: string | null = null;
  visit(doc, { Alias() { refused = 'an alias (`*name`)'; return visit.BREAK; }, Node(_, n) { if ((n as { anchor?: string }).anchor) { refused = 'an anchor (`&name`)'; return visit.BREAK; } if ((n as { tag?: string }).tag && !/^tag:yaml\.org,2002:/.test((n as { tag: string }).tag)) { refused = 'a tag'; return visit.BREAK; } return undefined; } });
  if (refused) return { error: `its frontmatter uses ${refused}; write the value itself` };
  if (doc.contents !== null && !isMap(doc.contents) && !isAlias(doc.contents)) return { error: 'its frontmatter is not a set of fields (`title: Hello`)' };
  const fields = (doc.toJS() ?? {}) as Record<string, unknown>;
  const taken = RESERVED.find((k) => k in fields);
  if (taken) return { error: `its frontmatter has a field \`${taken}\`, which sinter writes (${RESERVED.map((k) => `\`${k}\``).join(', ')} are reserved)` };
  return { value: { ...fields, body: text.slice(m[0].length) } };
}

/**
 * Values parsed, by file and text: a build compiles many pages over one glob, and the editor compiles a page at each
 * keystroke, so a file whose text is unchanged is not parsed again. Values are shared, never changed in place (the
 * compiler copies what it sorts or filters, and freezes what it folds).
 */
const parsed = new Map<string, { text: string; out: { value: unknown } | { error: string } }>();
const PARSED_LIMIT = 20_000;

/** The value of one file: a markdown file's frontmatter and `body`, a `.json` file's parsed value, else its text. */
export function fileValue(text: string, path: string): { value: unknown } | { error: string } {
  const kept = parsed.get(path);
  if (kept && kept.text === text) return kept.out;
  const out = parseValue(text, path);
  if (parsed.size >= PARSED_LIMIT) parsed.clear();
  parsed.set(path, { text, out });
  return out;
}

function parseValue(text: string, path: string): { value: unknown } | { error: string } {
  const name = path.replace(/^.*\//, '');
  if (isMarkdown(path)) { const f = frontmatter(text); return 'error' in f ? { error: `\`${name}\`: ${f.error}` } : f; }
  if (!/\.json$/i.test(path)) return { value: text };
  try { return { value: JSON.parse(text) }; } catch (e) { return { error: `\`${name}\` is not valid JSON: ${(e as Error).message}` }; }
}

/**
 * One entry of a glob's list: the file's value as an object (a text file's is `{ body }`) with `slug` (its name without
 * the extension, unless it gives one), `dir` (its folder below the glob's fixed part) and `path` (from the root).
 */
export function fileEntry(text: string, file: string, base: string, root: string): { value: Record<string, unknown> } | { error: string } {
  const name = file.replace(/^.*\//, '');
  const v = fileValue(text, file);
  if ('error' in v) return v;
  let fields: Record<string, unknown>;
  if (isMarkdown(file)) fields = v.value as Record<string, unknown>;
  else if (/\.json$/i.test(file)) {
    if (!v.value || typeof v.value !== 'object' || Array.isArray(v.value)) return { error: `\`${name}\` is not an object: each file of a glob is one entry` };
    fields = v.value as Record<string, unknown>;
    const taken = ['dir', 'path'].find((k) => k in fields);
    if (taken) return { error: `\`${name}\` has a field \`${taken}\`, which sinter writes (\`slug\` may be given; \`dir\` and \`path\` are reserved)` };
  } else fields = { body: v.value };
  const top = normalize(root).replace(/\/$/, '');
  const dir = file.slice(base.replace(/\/$/, '').length + 1).replace(/\/?[^/]*$/, '');
  const slug = typeof fields.slug === 'string' || typeof fields.slug === 'number' ? fields.slug : name.replace(/\.[^.]*$/, '');
  return { value: { ...fields, slug, dir, path: file.slice(top.length) } };
}

/** the fields sinter adds to each entry of a glob, as a type */
export const FILE_ENTRY = '{ slug: string; dir: string; path: string }';

/** `obj` with the value at `path` replaced (a copy of each object on the way) */
export function setPath(obj: unknown, path: string[], v: unknown): unknown {
  if (!path.length) return v;
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  return Array.isArray(o) ? o : { ...o, [path[0]!]: setPath(o[path[0]!], path.slice(1), v) };
}

/** A list sorted once by `order` (`date`, `-date`), as a live resource keeps it: missing values last, strings by `locale`. */
export function sortList(list: unknown[], order: string, locale: string | undefined): unknown[] {
  const field = order.replace(/^-/, ''), dir = order.startsWith('-') ? -1 : 1;
  const collator = new Intl.Collator(locale || 'en', { numeric: true });
  return list.map((x, i) => [x, i] as const).sort(([a, i], [b, j]) => {
    const x = (a as Record<string, unknown>)?.[field], y = (b as Record<string, unknown>)?.[field];
    if (x == null || y == null) return (+(x == null) - +(y == null)) || i - j;
    const c = typeof x === 'string' && typeof y === 'string' ? collator.compare(x, y) : +(x! > y!) - +(x! < y!);
    return dir * c || i - j;
  }).map(([x]) => x);
}

/** The value as the text of a `<script type="application/json">` in the head: `</script` and comments cannot close it. */
export const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

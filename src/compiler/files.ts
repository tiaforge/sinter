// The `file:` source (docs/resources.md#files): `<sn-resource src="file:./post.txt">` reads a file of the
// repository at build time. Its value is the file's text, or for `.json` its parsed value; it is a
// constant, so nothing loads, refreshes or writes it. Until helpers fold at build time it reaches the
// browser as embedded data, written into the head (not a placeholder a server fills). What needs no
// compiler state is here; `compile.ts` calls it from `resource()`.
import { normalize } from 'node:path/posix';

/** the built-in name of the source in `src` (beside `site`), and so a reserved API name */
export const FILE = 'file';

/** whether a `src` (or an action's URL) is a `file:` source */
export const isFileSource = (value: string | undefined) => value != null && /^file:/.test(value.trimStart());

/** the attributes a `file:` resource takes: the others load, refresh, page or write it */
export const FILE_ATTRS = ['name', 'src', 'type', 'items', 'key'];

/** Why an attribute of `<sn-resource>` does not apply to a `file:` resource. */
export function fileAttrProblem(name: string): string {
  const what: Record<string, string> = {
    refresh: 'reloads', cache: 'caches responses', paginate: 'loads pages', each: 'sends a request per item', call: 'runs an action function',
    when: 'decides when to load', then: 'runs after a load', early: 'decides how it is requested', method: 'sends a request', body: 'sends a request body',
    order: 'keeps its items sorted as they change', total: 'reads a total from a response',
  };
  const why = what[name] ?? (/^(page-size|size-param|cursor|direction-param|direction-values|page-param|offset-param|page-model)$/.test(name) ? 'pages a list' : null);
  return why
    ? `\`${name}\` ${why}, and a \`file:\` resource is a constant: it is read at build time and never loads or changes; it takes only \`name\`, \`type\`, \`items\` and \`key\``
    : `\`${name}\` is not an attribute of a \`file:\` resource, which takes only \`name\`, \`type\`, \`items\` and \`key\``;
}

/**
 * The file a `file:` source names: a literal path, relative to the file that wrote it (a page, a layout,
 * a component), or `/…` from the project root, and inside the root. Paths are `/`-separated.
 */
export function filePath(value: string, from: string, root: string): { path: string } | { error: string } {
  const rel = value.trim().slice('file:'.length);
  if (rel.includes('{')) return { error: 'a `file:` path is a literal: an interpolation (`{…}`) would make the page depend on data, and pages per file are not supported' };
  if (!rel) return { error: '`file:` needs a path: `file:./post.txt`, or `file:/content/post.txt` from the project root' };
  if (/[?#]/.test(rel)) return { error: 'a `file:` path takes no query or fragment' };
  const top = normalize(root.replace(/\\/g, '/')).replace(/\/$/, '');
  const dir = from.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const path = normalize(rel.startsWith('/') ? `${top}${rel}` : `${dir}/${rel}`);
  if (!path.startsWith(top + '/')) return { error: `\`${rel}\` is outside the project root: a \`file:\` source reads the project's own files` };
  return { path };
}

/** The value of a file: its text, or for `.json` its parsed value. */
export function fileValue(text: string, path: string): { value: unknown } | { error: string } {
  if (!/\.json$/i.test(path)) return { value: text };
  try { return { value: JSON.parse(text) }; } catch (e) { return { error: `\`${path.replace(/^.*\//, '')}\` is not valid JSON: ${(e as Error).message}` }; }
}

/** The value as the text of a `<script type="application/json">` in the head: `</script` and comments cannot close it. */
export const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

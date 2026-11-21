// @tiaforge-ui/sinter/messages/content: the messages as a content namespace (docs/proposals/messages.md §2), for the
// app's content module. `inlang()` reads an inlang project's message files (the inlang message format, version 4) into
// one list per language of `{ id, m }`, a message's compact form (./format.ts), which pages call as `m.inbox.title()`.
// It is one loader among others: an app that uses another library registers its own namespace and ships none of this.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { namespace, type Collection } from '../content.js';
import type { Message } from './format.js';
import { flatten } from './parse.js';

export { flatten, parseComplex, parsePattern } from './parse.js';

/** an inlang project's settings, as the loader reads them */
interface Settings { baseLocale?: unknown; locales?: unknown; 'plugin.inlang.messageFormat'?: { pathPattern?: unknown } }

const read = (root: string, project: string): Settings => {
  const file = resolve(root, project, 'settings.json');
  try { return JSON.parse(readFileSync(file, 'utf8')) as Settings; } catch (e) { throw new Error(`inlang(): ${project}/settings.json could not be read: ${String((e as Error)?.message ?? e).split('\n')[0]}`); }
};

/** The project's languages, for the content module's `languages()`: `languages(inlangLocales('project.inlang'))`. */
export function inlangLocales(project = 'project.inlang', root = process.cwd()): { base: string; list: string[] } {
  const s = read(root, project);
  const list = Array.isArray(s.locales) ? s.locales.filter((l): l is string => typeof l === 'string') : [];
  if (typeof s.baseLocale !== 'string' || !list.includes(s.baseLocale)) throw new Error(`inlang(): ${project}/settings.json needs \`baseLocale\`, one of \`locales\``);
  return { base: s.baseLocale, list };
}

/**
 * The messages of an inlang project as a content namespace (`m` by default), loaded per language:
 * `export const messages = inlang({ project: 'project.inlang' })` in the content module, with `languages()` from the
 * same project (`inlangLocales`). `pathPattern` may be a list: its files are merged in order. Turn the built-in
 * messages off (`sinter({ messages: false })`): one name calls one namespace.
 */
export function inlang<Tn = never>(o: {
  project?: string; namespace?: string;
  /**
   * per tenant (docs/proposals/axes.md §6): the tenants' list, and a tenant's own files (`{locale}` in them), merged over
   * the project's: a tenant's file holds only the messages it changes. The languages are then `languages()`'s list,
   * which `per` names too: `per: [tenants, locales]`
   */
  per?: readonly Collection<any>[]; tenantFiles?: (tenant: Tn) => string;
} = {}): Collection<{ id: string; m: Message }> {
  const project = o.project ?? 'project.inlang';
  return namespace<{ id: string; m: Message }>({
    name: o.namespace ?? 'm', format: '@tiaforge-ui/sinter/messages/format', ...(o.per ? { per: o.per } : { perLocale: true }),
    types: (entries) => messagesType(entries),
    // app code: `import { m } from '@tiaforge-ui/sinter/messages'`, `m.inbox.title()`
    module: '@tiaforge-ui/sinter/messages',
    load: ({ locale, root, value }) => {
      const s = read(root, project);
      const pp = s['plugin.inlang.messageFormat']?.pathPattern ?? './messages/{locale}.json';
      const patterns = (Array.isArray(pp) ? pp : [pp]).map(String);
      // a tenant's own files after the project's: what it changes wins
      const t = o.per && o.tenantFiles ? o.per.map((c) => value(c)).find((x) => x && !(x as { tag?: unknown }).tag) : undefined;
      if (t !== undefined && o.tenantFiles) patterns.push(o.tenantFiles(t as Tn));
      const all = new Map<string, Message>();
      for (const p of patterns) {
        const file = resolve(root, project, '..', p.replace('{locale}', locale ?? String(s.baseLocale)));
        let json: Record<string, unknown>;
        try { json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { continue; }
        for (const [k, v] of flatten(json, p.replace('{locale}', locale ?? ''))) all.set(k, v);
      }
      return [...all].map(([id, m]) => ({ id, m }));
    },
  });
}

/**
 * The messages' type for `sinter check`, from the base language's: nested objects for dotted ids, each message a function
 * of its inputs (a plural's `number`, a selector's or a placeholder's `string | number`), without arguments when it has none
 */
export function messagesType(entries: Array<{ id: string; m: Message }>): string {
  type Tree = { [k: string]: Tree | string };
  const tree: Tree = {};
  for (const { id, m } of entries) {
    const inputs = new Map<string, string>();
    const parts = 'p' in m ? m.p : m.v.flatMap(([, p]) => p);
    for (const x of parts) if (typeof x !== 'string') inputs.set(x.v, 'string | number');
    if ('s' in m) for (const sel of m.s) inputs.set(sel.n, sel.f ? 'number' : 'string | number');
    const fn = inputs.size ? `(args: { ${[...inputs].map(([k, t]) => `${JSON.stringify(k)}: ${t}`).join('; ')} }) => string` : '() => string';
    const path = id.split('.');
    let at = tree;
    for (const k of path.slice(0, -1)) at = (at[k] ??= {}) as Tree;
    at[path.at(-1)!] = fn;
  }
  const show = (t: Tree): string => `{ ${Object.entries(t).map(([k, v]) => `${JSON.stringify(k)}: ${typeof v === 'string' ? v : show(v)}`).join('; ')} }`;
  return show(tree);
}

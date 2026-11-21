// Languages in the URL (`sinter({ localePrefix: true })`, docs/static-pages.md#languages): reading the site's
// languages from the inlang project, and the language `sinter check` and the editor compile in. What the languages
// do (prefixes, choosers, `hreflang`, choosing a visitor's) is `locales.ts`.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LANGUAGE_TAG } from './content.js';
import { snapshotLanguages } from './content-node.js';

export type { Locales } from './locales.js';
import type { Locales } from './locales.js';

/**
 * The languages for `localePrefix`, from the inlang project's settings. `baseLocale` decides where every
 * visitor without a choice lands, so it must be there and among `locales` (no silent `en`).
 */
export function readLocales(root: string, project = 'project.inlang'): Locales {
  const file = resolve(root, project, 'settings.json');
  if (!existsSync(file)) throw new Error(`sinter({ localePrefix }): no inlang project at ${project}/settings.json: the languages come from it (\`baseLocale\`, \`locales\`)`);
  const s = JSON.parse(readFileSync(file, 'utf8')) as { baseLocale?: unknown; locales?: unknown };
  const list = Array.isArray(s.locales) ? s.locales.filter((l): l is string => typeof l === 'string') : [];
  if (typeof s.baseLocale !== 'string') throw new Error(`sinter({ localePrefix }): ${project}/settings.json has no \`baseLocale\`: it is the language a visitor without a choice is sent to`);
  if (!list.includes(s.baseLocale)) throw new Error(`sinter({ localePrefix }): \`baseLocale\` \`${s.baseLocale}\` is not among \`locales\` (${list.join(', ') || 'none'}) in ${project}/settings.json`);
  for (const l of list) if (!LANGUAGE_TAG.test(l)) throw new Error(`sinter({ localePrefix }): \`${l}\` in \`locales\` is not a language tag (it becomes the URL's prefix, \`/${l}/\`)`);
  return { base: s.baseLocale, list };
}

/**
 * The language `sinter check` and the editor compile a page in: with `localePrefix` the build compiles each page once
 * per language, and the check uses the base one (`$locale`, `{$locale}` in a `file:` path); without it, none. The
 * languages are the content module's `languages()`, as the last build or dev server recorded them, else the inlang
 * project's.
 */
export function checkLocale(root: string, options: { localePrefix?: boolean; messages?: unknown }): { name: string; urls: null; base: string } | null {
  if (!options.localePrefix) return null;
  const declared = snapshotLanguages(root);
  if (declared) return { name: declared.base, urls: null, base: '/' };
  return null;
}

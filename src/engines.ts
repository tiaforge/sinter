// Utility-CSS engines whose CSS does not exist yet when sinter reads the page's stylesheets: a
// Vite plugin generates it from the class names it finds (Tailwind's `@tailwindcss/vite`, UnoCSS),
// and in a build that happens after the HTML is transformed. Every such engine has a compiler that
// turns class names into CSS, and sinter has the page's markup, so each adapter asks the project's
// own engine (its installed version, its config and theme) for the CSS of this page's classes.
// That is all the cascade needs: a utility no element of the page uses matches nothing. See
// docs/images.md. An engine through PostCSS (`@tailwindcss/postcss`, `@unocss/postcss`) needs no
// adapter: `preprocessCSS` runs it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface StyleEngine {
  name: string;
  /** a stylesheet this engine generates: an import as written (`virtual:uno.css`), or a file with its text */
  owns(id: string, code: string | null): boolean;
  /** its CSS for a page whose markup is `markup` (classes the page uses), with the files it read */
  css(id: string, code: string | null, markup: string): Promise<{ code: string; deps: string[] } | null>;
}

/** Tailwind's directives: a stylesheet with one of them is Tailwind's to compile */
const TAILWIND = /@(?:import\s+(?:url\()?\s*["']tailwindcss(?:\/[^"']*)?["']|tailwind\b|theme\b|utility\b|apply\b|plugin\b|config\b|source\b|reference\b|custom-variant\b|variant\b)/;
const UNO = /^(?:virtual:)?uno(?:-[\w-]+)?\.css$|(?:^|\/)__uno(?:_[\w-]+)?\.css$/;

/** The engines the Vite config's plugins use, loaded from the project (else from sinter's own dependencies). */
export function detectEngines(root: string, plugins: string[]): StyleEngine[] {
  const engines: StyleEngine[] = [];
  const load = async <T>(pkg: string, via?: string): Promise<T> => {
    for (const from of [root, dirname(fileURLToPath(import.meta.url))]) {
      const start = via ? packageDir(via, from) : from;
      const entry = start && packageEntry(pkg, start);
      if (entry) return await import(pathToFileURL(entry).href) as T;
    }
    throw new Error(`${pkg} is not installed`);
  };
  /** class-name candidates: every token of the markup (an engine ignores what is not one of its utilities) */
  const candidates = (markup: string) => [...new Set(markup.split(/[\s"'`<>=]+/).filter((t) => t && t.length < 200))];

  if (plugins.some((p) => p.startsWith('@tailwindcss/vite'))) {
    type Tw = { compile(css: string, o: { base: string; onDependency(path: string): void }): Promise<{ build(c: string[]): string }> };
    const compilers = new Map<string, Promise<{ build(c: string[]): string; deps: string[] }>>();
    engines.push({
      name: 'tailwind',
      owns: (id, code) => /\.css$/i.test(id) && code !== null && TAILWIND.test(code),
      async css(file, code, markup) {
        const key = `${file}\0${code}`;
        let c = compilers.get(key);
        if (!c) {
          c = load<Tw>('@tailwindcss/node', '@tailwindcss/vite').then(async (tw) => {
            const deps: string[] = [];
            const compiler = await tw.compile(code!, { base: dirname(file), onDependency: (d) => deps.push(d) });
            return { build: (x: string[]) => compiler.build(x), deps };
          });
          compilers.set(key, c);
          c.catch(() => compilers.delete(key));
        }
        const compiler = await c;
        return { code: compiler.build(candidates(markup)), deps: compiler.deps };
      },
    });
  }

  if (plugins.some((p) => p.startsWith('unocss'))) {
    type Uno = { createGenerator(config: object): Promise<{ generate(code: string, o: { preflights: boolean }): Promise<{ css: string }> }> };
    type UnoConfig = { loadConfig(cwd: string): Promise<{ config: object; sources: string[] }> };
    let generator: { stamps: Array<[string, number]>; gen: Promise<Awaited<ReturnType<Uno['createGenerator']>>>; sources: string[] } | null = null;
    const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return -1; } };
    engines.push({
      name: 'unocss',
      owns: (id) => UNO.test(id),
      async css(_id, _code, markup) {
        if (!generator || generator.stamps.some(([f, m]) => mtime(f) !== m)) {
          const [{ createGenerator }, { loadConfig }] = await Promise.all([load<Uno>('@unocss/core', 'unocss'), load<UnoConfig>('@unocss/config', 'unocss')]);
          const { config, sources } = await loadConfig(root);
          generator = { stamps: sources.map((f) => [f, mtime(f)]), gen: createGenerator(config), sources };
        }
        const { css } = await (await generator.gen).generate(markup, { preflights: true });
        return { code: css, deps: generator.sources };
      },
    });
  }
  return engines;
}

/** The directory of package `pkg` as Node finds it from `from` (the nearest node_modules up the tree). */
function packageDir(pkg: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', pkg);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** The ESM entry of `pkg`: its `exports` (the `import`, `node` or `default` condition), else `module` or `main`. */
function packageEntry(pkg: string, from: string): string | null {
  const dir = packageDir(pkg, from);
  if (!dir) return null;
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: unknown; module?: string; main?: string };
  const pick = (e: unknown): string | null => {
    if (typeof e === 'string') return e;
    if (Array.isArray(e)) { for (const x of e) { const r = pick(x); if (r) return r; } return null; }
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      if ('.' in o) return pick(o['.']);
      for (const k of ['import', 'node', 'default']) if (k in o) { const r = pick(o[k]); if (r) return r; }
    }
    return null;
  };
  const rel = (json.exports !== undefined ? pick(json.exports) : null) ?? json.module ?? json.main ?? 'index.js';
  return join(dir, rel);
}

// The app's own tsconfig, as the check uses it: a component file's `<script>` is checked under it (a second
// program whose tsconfig `extends` it), and the pages' expressions follow its `strictNullChecks`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface AppTsconfig {
  /** absolute path of the tsconfig the app's `src/` is compiled with */
  file: string;
  /** whether it checks nulls (`strictNullChecks`, else `strict`) */
  strictNullChecks: boolean;
  /** the declaration files it compiles (`src/vite-env.d.ts`, …): globals a module of the app sees without importing them */
  declarations: string[];
}

interface Shown { compilerOptions?: Record<string, unknown>; files?: string[]; references?: Array<{ path?: string }> }

/** The configs `file` extends, itself first, as far as they can be found (a JSONC reading of `extends`: only for the cache's key). */
function chain(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return [file]; }
  const m = /"extends"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])/.exec(text);
  const specs = m ? [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!) : [];
  const out = [file];
  for (const spec of specs) {
    let p: string | null = null;
    if (spec.startsWith('.') || isAbsolute(spec)) {
      p = resolve(dirname(file), spec);
      if (!existsSync(p) && existsSync(p + '.json')) p += '.json';
    } else {
      const req = createRequire(file);
      for (const s of [spec, spec + '/tsconfig.json', spec + '.json']) { try { p = req.resolve(s); break; } catch { /* next */ } }
    }
    if (p) out.push(...chain(p, seen));
  }
  return out;
}

/** What `tsc --showConfig` said, by config file, with the modification times of the configs it read. */
const cache = new Map<string, { key: string; value: Shown | null }>();

const stamp = (file: string) => chain(file).map((f) => { try { return `${f}@${statSync(f).mtimeMs}`; } catch { return `${f}@-`; } }).join('|');

/**
 * `tsc --showConfig`: the config as TypeScript reads it (its `extends` merged, its files listed), or null; cached
 * until a config of its `extends` chain changes, so the editor's checks do not each start a tsc.
 */
function show(tsc: string, file: string): Shown | null {
  const key = `${tsc}|${stamp(file)}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.value;
  const value = showNow(tsc, file);
  cache.set(file, { key, value });
  return value;
}

function showNow(tsc: string, file: string): Shown | null {
  const run = spawnSync(process.execPath, [tsc, '--showConfig', '-p', file], { encoding: 'utf8', cwd: dirname(file) });
  if (run.error || run.status !== 0) return null;
  try { return JSON.parse(run.stdout) as Shown; } catch { return null; }
}

/**
 * The tsconfig of the app at `root` (`<root>/tsconfig.json`), read by the project's own TypeScript; null without
 * one (or when TypeScript cannot read it: the app's tsc says why). A solution-style tsconfig (`"files": []` and
 * `references`, as Vite's templates write) stands for the referenced one that compiles `src/`.
 */
export function appTsconfig(root: string, tsc: string): AppTsconfig | null {
  const file = join(root, 'tsconfig.json');
  if (!existsSync(file)) return null;
  let at = file;
  let shown = show(tsc, file);
  if (!shown) return null;
  if (!shown.files?.length && shown.references?.length) {
    const src = join(root, 'src');
    const found = shown.references.map((r) => {
      if (!r.path) return null;
      let p = resolve(dirname(file), r.path);
      try { if (statSync(p).isDirectory()) p = join(p, 'tsconfig.json'); } catch { return null; }
      const s = show(tsc, p);
      const inSrc = s?.files?.some((f) => !relative(src, resolve(dirname(p), f)).startsWith('..'));
      return s && inSrc ? { p, s } : null;
    }).find((r) => r);
    if (!found) return null;
    at = found.p;
    shown = found.s;
  }
  const o = shown.compilerOptions ?? {};
  const strict = typeof o.strictNullChecks === 'boolean' ? o.strictNullChecks : o.strict === true;
  const declarations = (shown.files ?? []).filter((f) => /\.d\.[cm]?ts$/.test(f)).map((f) => resolve(dirname(at), f));
  return { file: at, strictNullChecks: strict, declarations };
}

/**
 * What the program of the components' scripts sets over the app's options: nothing emitted. `checkJs` stays the
 * app's: a JS `<script>` is checked by its shadow's own `// @ts-check`, and the app's `.js` modules it imports are
 * checked only if the app checks them (their errors are its own tsc's business either way).
 */
export const SCRIPT_OVERRIDES = {
  noEmit: true, allowJs: true, skipLibCheck: true,
  composite: false, incremental: false, tsBuildInfoFile: null, declaration: false, declarationMap: false, emitDeclarationOnly: false,
  outDir: null, rootDir: null, sourceMap: false,
};

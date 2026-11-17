// Shared helper modules (builds, docs/first-paint.md#own-copies): a module that declares helpers an early
// binding calls is in the page's early file and, when the page bundle reaches it too, again in the page
// bundle. When every early file that imports it imports all of its exports, the page bundle takes the
// early file's instance instead: the early file leaves the module's namespace on a global, and in the
// page bundle the module is a stub that reads it, or imports its own copy (a chunk of its own) when the
// early file did not run (a swap, a blocked script, a page whose early file does not have it). The
// stub waits for that copy with a top-level `await`, so nothing that imports it runs before it. The
// build side is in vite.ts; this module holds what does not need the bundler.
import { createHash } from 'node:crypto';

/** the stub's id in the page bundle: `\0sinter-shared:<file>` */
export const SHARED = '\0sinter-shared:';
/** the module's own copy, which the stub imports when the early file's is not there */
export const OWN = '?sn-own';
/** the global the early files leave the namespaces on, by key */
export const SHARED_KEY = 'sinter.shared';

/**
 * A module's mark, written where its key goes (the stub, the early file's registration) and replaced once
 * the bundle is written: hex, so a minifier that turns `g["…"]` into `g.…` leaves a valid identifier.
 */
export const sharedMark = (file: string) => `__SN_SHARED__${createHash('sha256').update(file).digest('hex').slice(0, 12)}__`;
/** any mark, with the hash it names */
export const SHARED_MARKS = /__SN_SHARED__([0-9a-f]{12})__/g;

/**
 * The key that replaces a module's mark: from its own copy's chunk name, which changes with its code and imports. As
 * long as the mark, so the chunks' source maps keep their columns.
 */
export const sharedKey = (ownChunk: string) => `k${createHash('sha256').update(ownChunk).digest('hex').slice(0, 26)}`;

/**
 * The named imports of an early module, by specifier: the compiler writes one
 * `import { a, b as c } from "…";` per module (`helperImports`); other forms are not counted.
 */
export function earlyImports(code: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of code.matchAll(/^import \{([^}]*)\} from (["'])([^"']+)\2;$/gm)) {
    const names = m[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!).filter(Boolean);
    out.set(m[3]!, [...(out.get(m[3]!) ?? []), ...names]);
  }
  return out;
}

/** The stub that stands for `file` in the page bundle: the early file's instance, else the module's own copy. */
export function stubModule(file: string, exports: readonly string[]): string {
  const names = [...new Set(exports)];
  return [
    `const g = globalThis[Symbol.for(${JSON.stringify(SHARED_KEY)})]?.[${JSON.stringify(sharedMark(file))}];`,
    `const m = g ?? await import(${JSON.stringify(file + OWN)});`,
    ...(names.length ? [
      `const { ${names.map((n, i) => `${JSON.stringify(n)}: $${i}`).join(', ')} } = m;`,
      `export { ${names.map((n, i) => `$${i} as ${/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n)}`).join(', ')} };`,
    ] : []),
    '',
  ].join('\n');
}

/** The lines an early module starts with: each shared module's namespace on the global. */
export function registration(modules: ReadonlyArray<{ spec: string; file: string }>): string {
  return modules.map((x, i) => `import * as $sn$sh${i} from ${JSON.stringify(x.spec)};\n(globalThis[Symbol.for(${JSON.stringify(SHARED_KEY)})] ??= {})[${JSON.stringify(sharedMark(x.file))}] = $sn$sh${i};\n`).join('');
}

/** the first version of each engine with top-level `await` in modules */
const TLA: Record<string, number> = { chrome: 89, edge: 89, firefox: 89, safari: 15, ios: 15, opera: 75, node: 14.8, deno: 1, es: 2022 };

/**
 * Whether a Vite `build.target` supports top-level `await`: every entry must (`esnext`, `es2022` and later,
 * the engines' versions); an entry this does not know counts as not.
 */
export function topLevelAwait(target: unknown): boolean {
  const list = typeof target === 'string' ? [target] : Array.isArray(target) ? target : [];
  if (!list.length) return false;
  return list.every((t) => {
    if (typeof t !== 'string') return false;
    const s = t.toLowerCase();
    if (s === 'esnext' || s === 'baseline-widely-available') return true;
    const m = /^([a-z]+)(\d+(?:\.\d+)?)/.exec(s);
    if (!m || !(m[1]! in TLA)) return false;
    return Number(m[2]) >= TLA[m[1]!]!;
  });
}

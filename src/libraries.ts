// Component libraries (docs/libraries.md): packages named in `sinter({ libraries })` ship source,
// an app-shaped folder their `package.json` names (`"sinter": "./sinter"`) with `components/`
// (public), `components/internal/` (internal), `sinter.helpers.ts` and `sinter.types.ts`. The app's
// sinter compiles them as it compiles the app's own components. A package owns the first segment of
// its components' names, its prefix.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from './compiler/diagnostics.js';
import { COMPONENT_NAME } from './compiler/components.js';

export interface Library {
  /** the package name, `@acme/ui` */
  name: string;
  /** the package's folder as the app finds it (`<root>/node_modules/@acme/ui`, a workspace link kept as a link) */
  dir: string;
  /** its real path, which may be outside the project root */
  real: string;
  /** the app-shaped folder `"sinter"` names, under `dir` */
  folder: string;
  /** the first segment of its components' names */
  prefix: string | null;
  /** components in `components/` */
  public: string[];
  /** components in `components/internal/` */
  internal: string[];
  /** its helpers module (`sinter.helpers.ts`), or null */
  helpers: string | null;
  /** its types module (`sinter.types.ts`), or null */
  types: string | null;
  /** the sinter versions it supports (`peerDependencies`), or null */
  peer: string | null;
  /** the package's version */
  version: string | null;
}

/** sinter's package name, as libraries name it in `peerDependencies` */
export const SINTER_PACKAGE = '@tiaforge-ui/sinter';

/** The `libraries` option, checked: package names (`@acme/ui`), not paths. */
export function librariesOf(list: unknown): string[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('sinter({ libraries }): takes a list of package names, e.g. `libraries: [\'@acme/ui\']`');
  for (const x of list) {
    if (typeof x !== 'string' || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(x)) throw new Error(`sinter({ libraries }): \`${String(x)}\` is not a package name; list component libraries from node_modules, e.g. \`'@acme/ui'\``);
  }
  return [...new Set(list as string[])];
}

/**
 * A project that is a component library itself (its package.json has `"sinter"`): its name, and the
 * fixture pages beside its folder (`fixtures/**\/*.html`), which its own `sinter check` compiles.
 */
export function ownLibrary(root: string): { name: string; pages: string[] } | null {
  let pkg: { name?: unknown; sinter?: unknown };
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return null; }
  if (typeof pkg.name !== 'string' || typeof pkg.sinter !== 'string') return null;
  const dir = join(dirname(join(root, pkg.sinter)), 'fixtures');
  const pages: string[] = [];
  const walk = (d: string) => {
    let list: string[] = [];
    try { list = readdirSync(d).sort(); } catch { return; }
    for (const f of list) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== 'node_modules' && !f.startsWith('.')) walk(p); } else if (f.endsWith('.html')) pages.push(p);
    }
  };
  walk(dir);
  return { name: pkg.name, pages };
}

/** The package's folder: the project itself when it is the package, else `node_modules/<name>` in the root or a folder above it, as found (links not followed). */
export function packageDir(root: string, name: string): string | null {
  if (ownLibrary(root)?.name === name) return resolve(root);
  for (let d = resolve(root); ; d = dirname(d)) {
    const p = join(d, 'node_modules', ...name.split('/'));
    if (existsSync(join(p, 'package.json'))) return p;
    if (dirname(d) === d) return null;
  }
}

const names = (dir: string): string[] => {
  try { return readdirSync(dir).filter((f) => f.endsWith('.html') && COMPONENT_NAME.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort(); } catch { return []; }
};
const firstOf = (dir: string, base: string, exts: string[]) => exts.map((e) => join(dir, base + e)).find((f) => existsSync(f)) ?? null;

/** sinter's own version, from its package.json (one folder above `src/` and `dist/`). */
export function sinterVersion(): string | null {
  try { return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version?: string }).version ?? null; } catch { return null; }
}

/** The library a package of the folder is, read from its `package.json`; problems as diagnostics. */
export function readLibrary(name: string, dir: string, diagnostics: Diagnostic[], at: string): Library | null {
  const pkgFile = join(dir, 'package.json');
  const fail = (message: string, hint?: string, file = pkgFile): null => {
    diagnostics.push({ severity: 'error', code: 'SN337', message, file, line: 1, col: 1, ...(hint ? { hint } : {}) });
    return null;
  };
  let pkg: { name?: string; version?: string; sinter?: unknown; peerDependencies?: Record<string, string> };
  try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')); } catch (e) { return fail(`\`${name}\` (in \`sinter({ libraries })\`): its package.json cannot be read: ${(e as Error).message}`, undefined, at); }
  if (typeof pkg.sinter !== 'string') {
    return fail(`\`${name}\` is in \`sinter({ libraries })\` and its package.json has no \`"sinter"\` field: a component library names the folder of its components`, '`"sinter": "./sinter"`, a folder with `components/`, `sinter.helpers.ts` and `sinter.types.ts`');
  }
  const folder = normalize(join(dir, pkg.sinter));
  if (folder !== dir && !folder.startsWith(dir + sep)) return fail(`\`${name}\`: \`"sinter": ${JSON.stringify(pkg.sinter)}\` is outside the package`);
  let isDir = false;
  try { isDir = statSync(join(folder, 'components')).isDirectory(); } catch { /* missing */ }
  if (!isDir) return fail(`\`${name}\`: its \`"sinter"\` folder (\`${pkg.sinter}\`) has no \`components/\` folder`, 'components in `components/` are public, those in `components/internal/` internal');
  let real = dir;
  try { real = realpathSync(dir); } catch { /* as found */ }
  const pub = names(join(folder, 'components')), internal = names(join(folder, 'components', 'internal'));
  const both = pub.filter((n) => internal.includes(n));
  if (both.length) return fail(`\`${name}\`: ${both.map((n) => `\`${n}\``).join(', ')} is both in \`components/\` and \`components/internal/\``, undefined, join(folder, 'components', 'internal', `${both[0]}.html`));
  const all = [...pub, ...internal];
  const prefixes = [...new Set(all.map((n) => n.split('-')[0]!))];
  if (prefixes.length > 1) {
    const prefix = prefixes.sort((a, b) => all.filter((n) => n.startsWith(b + '-')).length - all.filter((n) => n.startsWith(a + '-')).length)[0]!;
    const off = all.filter((n) => !n.startsWith(prefix + '-'));
    return fail(`\`${name}\`: a library's component names share their first segment, the prefix it owns; ${off.map((n) => `\`${n}\``).join(', ')} ${off.length > 1 ? 'do' : 'does'} not start with \`${prefix}-\``, `rename ${off.length > 1 ? 'them' : 'it'} \`${prefix}-…\``, join(folder, 'components', internal.includes(off[0]!) ? 'internal' : '', `${off[0]}.html`));
  }
  return {
    name, dir, real, folder, prefix: prefixes[0] ?? null, public: pub, internal,
    helpers: firstOf(folder, 'sinter.helpers', ['.ts', '.js']),
    types: firstOf(folder, 'sinter.types', ['.ts', '.d.ts', '.js']),
    peer: pkg.peerDependencies?.[SINTER_PACKAGE] ?? null,
    version: pkg.version ?? null,
  };
}

/**
 * The libraries of `sinter({ libraries })`, found from the root, with what is wrong: a package
 * that is not installed, has no `"sinter"` folder or none with `components/` (SN337); two packages,
 * or a package and an app component, with one prefix (SN338); a sinter version outside a library's
 * `peerDependencies` range (SN537). `config` is the file problems with the option itself point at.
 */
export function libraries(root: string, list: string[], appComponents: string[], config: string): { libraries: Library[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const out: Library[] = [];
  const version = sinterVersion();
  for (const name of list) {
    const dir = packageDir(root, name);
    if (!dir) {
      diagnostics.push({ severity: 'error', code: 'SN337', message: `\`${name}\` is in \`sinter({ libraries })\` and is not installed: no \`node_modules/${name}\` in the project or a folder above it`, file: config, line: 1, col: 1, hint: `npm install ${name}` });
      continue;
    }
    const lib = readLibrary(name, dir, diagnostics, config);
    if (!lib) continue;
    const owner = out.find((l) => l.prefix && l.prefix === lib.prefix);
    if (owner) {
      diagnostics.push({ severity: 'error', code: 'SN338', message: `\`${lib.name}\` and \`${owner.name}\` both name their components \`${lib.prefix}-…\`: a prefix belongs to one package, and there is no shadowing`, file: config, line: 1, col: 1, hint: 'use one of them, or ask a library\'s author to rename its prefix' });
      continue;
    }
    if (lib.peer === null) {
      diagnostics.push({ severity: 'warning', code: 'SN537', message: `\`${lib.name}\` does not say which sinter versions it supports: a library lists \`"${SINTER_PACKAGE}"\` in \`peerDependencies\``, file: join(dir, 'package.json'), line: 1, col: 1, hint: version ? `"peerDependencies": { "${SINTER_PACKAGE}": "^${version}" }` : `list the sinter versions it supports in "peerDependencies": { "${SINTER_PACKAGE}": "…" }` });
    } else if (version && !satisfies(version, lib.peer)) {
      diagnostics.push({ severity: 'warning', code: 'SN537', message: `\`${lib.name}\` supports sinter \`${lib.peer}\`, and this is sinter ${version}: its markup may use what this version does not have, or what it no longer has`, file: join(dir, 'package.json'), line: 1, col: 1, hint: 'install a version of either that fits the other' });
    }
    out.push(lib);
  }
  for (const lib of out) {
    const taken = appComponents.filter((n) => lib.prefix && n.split('-')[0] === lib.prefix);
    for (const n of taken) diagnostics.push({ severity: 'error', code: 'SN338', message: `\`<${n}>\` starts with \`${lib.prefix}-\`, the prefix of \`${lib.name}\` (\`sinter({ libraries })\`): a library owns its prefix, and an app component cannot shadow or add to it`, file: join(root, 'src', 'components', `${n}.html`), line: 1, col: 1, hint: `rename it (\`app-${n.slice(lib.prefix!.length + 1)}\`); to change how a library component looks everywhere, wrap it in a component of your own` });
  }
  return { libraries: out, diagnostics };
}

/** The library a file belongs to (by its path as found, or its real path), or null. */
export function libraryOf(libs: readonly Library[], file: string): Library | null {
  const f = normalize(file);
  return libs.find((l) => f.startsWith(l.dir + sep) || f.startsWith(l.real + sep)) ?? null;
}

/** A library file as diagnostics name it: `@acme/ui/sinter/components/x.html`. */
export function libraryPath(libs: readonly Library[], file: string): string | null {
  const l = libraryOf(libs, file);
  if (!l) return null;
  const f = normalize(file);
  const base = f.startsWith(l.dir + sep) ? l.dir : l.real;
  return `${l.name}/${relative(base, f).split(sep).join('/')}`;
}

// ---- version ranges (npm's syntax: `^1.2.0`, `~1.2`, `>=1.0.0 <2`, `1.x`, `1.0.0 - 2.0.0`, `a || b`)

type V = [number, number, number];
const parse = (v: string): { v: V; parts: number } | null => {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[\w.]+)?(?:\+[\w.]+)?$/.exec(v.trim());
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined && !/[xX*]/.test(x)).length;
  return { v: [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0], parts };
};
const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const bump = (v: V, at: number): V => (at === 0 ? [v[0] + 1, 0, 0] : at === 1 ? [v[0], v[1] + 1, 0] : [v[0], v[1], v[2] + 1]);

/** Whether `version` is in an npm range. A range it cannot read counts as satisfied. */
export function satisfies(version: string, range: string): boolean {
  const ver = parse(version);
  if (!ver) return true;
  const v = ver.v;
  const alt = range.split('||').map((s) => s.trim());
  return alt.some((set) => {
    if (set === '' || set === '*' || /^[xX]$/.test(set)) return true;
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    if (hy) {
      const a = parse(hy[1]!), b = parse(hy[2]!);
      if (!a || !b) return true;
      return cmp(v, a.v) >= 0 && (b.parts === 3 ? cmp(v, b.v) <= 0 : cmp(v, bump(b.v, b.parts - 1)) < 0);
    }
    return set.split(/\s+/).every((c) => {
      const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(c);
      if (!m) return true;
      const p = parse(m[2]!);
      if (!p) return true;
      const [op, t] = [m[1] ?? '', p.v];
      if (op === '^') {
        const upper: V = t[0] > 0 || p.parts < 2 ? bump(t, 0) : t[1] > 0 || p.parts < 3 ? bump(t, 1) : bump(t, 2);
        return cmp(v, t) >= 0 && cmp(v, upper) < 0;
      }
      if (op === '~') return cmp(v, t) >= 0 && cmp(v, bump(t, p.parts < 2 ? 0 : 1)) < 0;
      if (op === '>=') return cmp(v, t) >= 0;
      if (op === '>') return p.parts === 3 ? cmp(v, t) > 0 : cmp(v, bump(t, Math.max(0, p.parts - 1))) >= 0;
      if (op === '<=') return p.parts === 3 ? cmp(v, t) <= 0 : cmp(v, bump(t, Math.max(0, p.parts - 1))) < 0;
      if (op === '<') return cmp(v, t) < 0;
      // `1.2.3`, `=1.2`, `1.x`: the versions it leaves open
      return p.parts === 0 || (cmp(v, t) >= 0 && cmp(v, p.parts === 3 ? bump(t, 2) : bump(t, p.parts - 1)) < 0);
    });
  });
}

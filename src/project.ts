// The app's conventional files (helpers, config and types modules), found the same
// way by the Vite plugin and by `sinter check`.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { readHelperManifest, type HelperManifest } from './compiler/index.js';

export interface ProjectOptions {
  /** helpers module, relative to the root (default `src/sinter.helpers.js`, or `.ts`) */
  helpers?: string;
  /** app configuration module imported before mount (default `src/sinter.config.js`, or `.ts`) */
  config?: string;
  /** module whose exported types `type="…"` on `<sn-resource>` may name (default `src/sinter.types.ts`, `.d.ts` or `.js`) */
  types?: string;
}

export interface Project {
  root: string;
  helpers: HelperManifest;
  /** absolute path of the helpers module, or null */
  helpersFile: string | null;
  /** root-relative URL of the config module (`/src/sinter.config.js`), or null */
  config: string | null;
  /** absolute path of the types module, or null */
  types: string | null;
  /** reads a file only if it resolves inside the root, symlinks included */
  readFile: (path: string) => string;
}

export function project(root: string, options: ProjectOptions = {}): Project {
  const find = (given: string | undefined, base: string, exts = ['.js', '.ts']): string | null => {
    const candidates = given ? [given] : exts.map((e) => base + e);
    for (const c of candidates) if (existsSync(resolve(root, c))) return c;
    return null;
  };
  const readFile = (path: string): string => {
    const real = realpathSync(path);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`outside the project root: ${path}`);
    return readFileSync(real, 'utf8');
  };
  const url = (rel: string) => '/' + rel.split(sep).join('/');

  let helpers: HelperManifest = { module: null, names: [], namespaces: {} };
  const helpersRel = find(options.helpers, 'src/sinter.helpers');
  const helpersFile = helpersRel ? resolve(root, helpersRel) : null;
  if (helpersRel && helpersFile) {
    helpers = readHelperManifest(readFileSync(helpersFile, 'utf8'), {
      module: url(helpersRel),
      file: helpersFile,
      readFile,
      resolve: (spec, from) => {
        if (!spec.startsWith('.')) return null;
        const base = resolve(dirname(from), spec);
        for (const p of [base, base.replace(/\.js$/, '.ts'), `${base}.js`, `${base}.ts`]) if (existsSync(p)) return p;
        return null;
      },
    });
  }
  const configRel = find(options.config, 'src/sinter.config');
  const typesRel = find(options.types, 'src/sinter.types', ['.ts', '.d.ts', '.js']);
  return {
    root, helpers, helpersFile, readFile,
    config: configRel ? url(configRel) : null,
    types: typesRel ? resolve(root, typesRel) : null,
  };
}

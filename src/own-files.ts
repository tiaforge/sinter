// sinter's own files (its dist/ and src/), wherever the package is: in node_modules, or a checkout linked into it
// (`npm link`, `file:`), whose real path is outside node_modules. The checks and rewrites of the app's own modules
// pass over them as they do over any package.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const slash = (p: string) => p.replace(/\\/g, '/');
const realOf = (p: string) => { try { return slash(realpathSync(p)); } catch { return slash(p); } };
// this file is dist/own-files.js (src/own-files.ts from source): the package's folder is the one above
// (none where this module is not a file: a test's browser-like environment)
let dirs: string[] | undefined;
const own = () => dirs ??= (() => {
  try { const pkg = realOf(fileURLToPath(new URL('..', import.meta.url))).replace(/\/?$/, '/'); return [`${pkg}dist/`, `${pkg}src/`]; } catch { return []; }
})();
const reals = new Map<string, string>();

/** Whether module `id` (a path, a Vite id with a query) is one of sinter's own files, by its path or its real path. */
export function sinterFile(id: string): boolean {
  const dirs = own();
  if (!dirs.length || id.startsWith('\0')) return false;
  const f = slash(id.replace(/[?#].*$/, ''));
  if (dirs.some((d) => f.startsWith(d))) return true;
  let real = reals.get(f);
  if (real === undefined) reals.set(f, (real = realOf(f)));
  return dirs.some((d) => real.startsWith(d));
}

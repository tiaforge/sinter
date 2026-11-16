// A throwaway app that uses the package as an app does: installed in node_modules (here a link to this
// folder, as a workspace or `npm link` makes it), named in `sinter({ components })`, and re-exported as
// the namespace `md` from the app's helpers module.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const PKG = resolve(import.meta.dirname, '..');
/** the sinter this package is tested against: the one installed beside it */
export const SINTER = realpathSync(join(PKG, 'node_modules/@tiaforge-ui/sinter'));

const HELPERS = "export * as md from '@tiaforge-ui/sinter-markdown';\n";
const TYPES = "export type { Root, TocEntry } from '@tiaforge-ui/sinter-markdown';\nexport interface Comment { id: number; author: string; body: string }\n";

/** a new app folder with `files` written into it; `remove()` deletes it */
export function app(files: Record<string, string | Uint8Array>): { root: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sinter-markdown-app-'));
  const all = { 'src/sinter.helpers.ts': HELPERS, 'src/sinter.types.ts': TYPES, ...files };
  for (const [f, s] of Object.entries(all)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), s);
  }
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  symlinkSync(PKG, join(root, 'node_modules/@tiaforge-ui/sinter-markdown'), 'dir');
  symlinkSync(SINTER, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** a page: a head with `head`, a body with `body` */
export const page = (body: string, head = '') => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>t</title>${head}</head>
<body>
${body}
</body>
</html>
`;

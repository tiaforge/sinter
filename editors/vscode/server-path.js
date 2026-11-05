// Finds the sinter installation a file belongs to, so each project runs its own
// `sinter lsp`. Kept free of the `vscode` module so it can be tested with Node alone.
'use strict';
const { existsSync, readFileSync } = require('node:fs');
const { dirname, isAbsolute, join, resolve } = require('node:path');

const PACKAGE = '@tiaforge/sinter';

/** The CLI of a sinter package directory, or null if it has none. */
function cliOf(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (pkg.name !== PACKAGE) return null;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.sinter;
    const cli = bin && join(pkgDir, bin);
    return cli && existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/**
 * The sinter CLI for a file: `override` (the `sinter.server.path` setting, relative to
 * `folder`) if set, else the nearest `node_modules/@tiaforge/sinter` above the file, else
 * the sinter repository itself. `root` is the directory whose files the server handles.
 * Returns null when the file is in no sinter project.
 */
function findServer(file, folder, override) {
  if (override) {
    const cli = isAbsolute(override) ? override : resolve(folder || dirname(file), override);
    return existsSync(cli) ? { cli, root: folder || dirname(file) } : null;
  }
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const installed = cliOf(join(dir, 'node_modules', PACKAGE));
    if (installed) return { cli: installed, root: dir };
    const self = cliOf(dir);
    if (self) return { cli: self, root: dir };
    if (dirname(dir) === dir) return null;
  }
}

module.exports = { findServer };

// The library's own check (docs/libraries.md, "Checking a library"): `sinter check` in this folder
// compiles and type-checks the fixture pages in fixtures/, which use the public components with the
// cases the library supports, and checks the library's rules: every declared slot is placed somewhere
// (SN331), `<sn-component use>` takes a map in components with slots (SN312), internal components stay
// internal (SN339). The same rules are checked again in each app's build.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { PKG } from './app.js';

test('the fixture pages check with no error and no warning', () => {
  const r = spawnSync(process.execPath, [join(PKG, 'node_modules/@tiaforge-ui/sinter/dist/cli.js'), 'check'], { cwd: PKG, encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  expect(out.split('\n').filter((l) => / (error|warning) SN\d+/.test(l))).toEqual([]);
  expect(out).toMatch(/sinter check: 3 page\(s\), 0 error\(s\), 0 warning\(s\)/);
  expect(r.status).toBe(0);
}, 120_000);

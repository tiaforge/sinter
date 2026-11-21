// @vitest-environment node
// Every module a compiled page imports is exported under `@tiaforge-ui/sinter/runtime`: a feature the compiler adds
// without an export fails an app's build ("not exported"), which the source-aliased tests would not see.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const repo = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as { exports: Record<string, string> };

test('each feature the compiler adds, and each module compiled pages import, is a runtime/ export', () => {
  const src = readFileSync(resolve(repo, 'src/compiler/compile.ts'), 'utf8');
  const features = [...src.matchAll(/features\.add\('([a-z-]+)'\)/g)].map((m) => m[1]!);
  expect(features.length).toBeGreaterThan(20);
  for (const f of [...new Set(features), 'early', 'lazy', 'swap', 'prefetch', 'remote', 'dev']) expect(pkg.exports, f).toHaveProperty([`./runtime/${f}`]);
  expect(pkg.exports['./runtime']).toBe('./dist/runtime-entry.js');
  // one name per module: the components feature (and the `Component` class its generated bases extend) is only under runtime/
  expect(Object.values(pkg.exports).filter((f) => f === './dist/components.js')).toEqual(['./dist/components.js']);
  expect(Object.keys(pkg.exports).filter((k, i, all) => all.findIndex((j) => pkg.exports[j] === pkg.exports[k]) !== i)).toEqual([]);
});

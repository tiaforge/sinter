// What the core imports goes whole into an app's shared chunk, which every page loads: a module only
// some pages need (array parameters, the typing pause) must not be reachable from it.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from 'vitest';

const reach = (file: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(file)) return seen;
  seen.add(file);
  // value imports and re-exports, not `import type`
  for (const m of readFileSync(file, 'utf8').matchAll(/^(?:import|export)(?! type)[^'"]*?from '(\.[^']+)\.js';/gm)) reach(resolve(dirname(file), m[1]! + '.ts'), seen);
  return seen;
};

test('the core reaches neither lists.ts nor wait.ts', () => {
  const core = [...reach(resolve(__dirname, '../src/index.ts'))].map((f) => f.slice(f.indexOf('/src/') + 1));
  expect(core).toContain('src/runtime/app.ts');
  expect(core).not.toContain('src/runtime/lists.ts');
  expect(core).not.toContain('src/runtime/wait.ts');
});

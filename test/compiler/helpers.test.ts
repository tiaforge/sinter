import { describe, expect, test } from 'vitest';
import { readHelperManifest } from '../../src/compiler/index.js';

const read = (source: string, file: string, files: Record<string, string> = {}) =>
  readHelperManifest(source, {
    module: '/src/' + file.split('/').pop(),
    file,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`no file ${p}`);
      return files[p]!;
    },
    resolve: (spec, from) => from.slice(0, from.lastIndexOf('/') + 1) + spec.replace(/^\.\//, ''),
  });

describe('helper manifest', () => {
  test('a JavaScript helpers module', () => {
    const m = read(`export const a = 1;\nexport function b() {}\nexport { c as d };\nconst c = 2;`, '/p/src/sinter.helpers.js');
    expect(m.names).toEqual(['a', 'b', 'd']);
  });

  test('a TypeScript helpers module: annotations parse, type-only exports are not helpers', () => {
    const source = `import type { Contact } from './types.ts';
import { type Other, value } from './other.ts';
export interface Draft { name: string }
export type Key = string;
export declare function declared(): void;
export enum Kind { A, B }
export const initial = (c: Contact): string => (c.name[0] ?? '?').toUpperCase();
export function first<T>(list: readonly T[]): T | undefined { return list[0]!; }
const local = value as unknown as Other;
export { local, type Draft as DraftAlias };
export type { Key as KeyAlias };
export * as m from './messages.ts';
`;
    const messages = `export const hello = (p: { name: string }): string => \`Hi \${p.name}\`;\nexport type Unused = number;\n`;
    const m = read(source, '/p/src/sinter.helpers.ts', { '/p/src/messages.ts': messages });
    expect(m.names).toEqual(['Kind', 'first', 'initial', 'local']);
    expect(m.namespaces).toEqual({ m: { module: '/src/messages.ts', members: ['hello'] } });
  });

  test('namespace members re-exported with `export *` are followed, as paraglide generates them', () => {
    const files = {
      '/p/src/paraglide/messages.js': `export * from './messages/_index.js'\nexport * as m from './messages/_index.js'\n`,
      '/p/src/paraglide/messages/_index.js': `export * from './hello.js'\nexport * from './items_count.js'\n`,
      '/p/src/paraglide/messages/hello.js': `const en_hello = () => 'Hello';\nexport const hello = (inputs = {}) => en_hello(inputs);\n`,
      '/p/src/paraglide/messages/items_count.js': `export { items_count };\nconst items_count = (i) => \`\${i.count} items\`;\nexport default items_count;\n`,
    };
    const m = read(`export * as m from './paraglide/messages.js';`, '/p/src/sinter.helpers.js', files);
    expect(m.namespaces.m!.members).toEqual(['hello', 'items_count']);
  });

  test('re-exports: helpers too, cycles end, packages and missing files are skipped', () => {
    const files = {
      '/p/src/a.ts': `export * from './b.ts';\nexport const a = 1;\n`,
      '/p/src/b.ts': `export * from './a.ts';\nexport * from 'some-package';\nexport * from './missing.ts';\nexport const b = 2;\n`,
    };
    const m = read(`export * from './a.ts';\nexport const own = 0;`, '/p/src/sinter.helpers.ts', files);
    expect(m.names).toEqual(['a', 'b', 'own']);
  });

  test('TypeScript syntax in a .js module is still a parse error', () => {
    expect(() => read(`export const a = (x: number) => x;`, '/p/src/sinter.helpers.js')).toThrow();
  });
});

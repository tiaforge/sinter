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

  test('TypeScript syntax in a .js module is still a parse error', () => {
    expect(() => read(`export const a = (x: number) => x;`, '/p/src/sinter.helpers.js')).toThrow();
  });
});

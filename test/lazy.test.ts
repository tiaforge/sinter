// @vitest-environment node
// Lazy packages, the build side (docs/lazy.md): which uses of a lazy package's imports a stub can
// serve (awaited calls), which it refuses (SN324), and how an import is rewritten.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { lazyDiagnostics, parseLazyId, reachLazy, rewriteLazy, scanLazy, stubId, stubModule } from '../src/lazy-build.js';
import { lazyOf } from '../src/project.js';

const scan = (code: string, file = 'a.ts') => scanLazy(code, file, ['openpgp', 'chart.js']);
const problems = (code: string) => scan(code).problems.map((p) => p.message);

describe('awaited calls', () => {
  test('a namespace import: the members it calls, awaited, returned, chained or discarded', () => {
    const s = scan(`import * as openpgp from 'openpgp';
export async function f(t: string) {
  const m = await openpgp.createMessage({ text: t });
  void openpgp.sign({ message: m });
  openpgp.readKey({ armoredKey: t }).then((k) => k.getFingerprint());
  return openpgp.encrypt({ message: m });
}
export const g = (a: string) => openpgp.readMessage({ armoredMessage: a });`);
    expect(s.problems).toEqual([]);
    expect([...s.lazy[0]!.names].sort()).toEqual(['createMessage', 'encrypt', 'readKey', 'readMessage', 'sign']);
  });

  test('nested calls: each call is checked on its own (Caley\'s keyring.ts)', () => {
    const s = scan(`import * as openpgp from 'openpgp';
export async function verify(text: string, sig: string, keys: unknown[]) {
  return (await openpgp.verify({ message: await openpgp.createMessage({ text }), signature: await openpgp.readSignature({ armoredSignature: sig }), verificationKeys: keys as never })).signatures;
}`);
    expect(s.problems).toEqual([]);
    expect([...s.lazy[0]!.names].sort()).toEqual(['createMessage', 'readSignature', 'verify']);
  });

  test('named and default imports; Promise.all, ternaries and `as` pass the wait through', () => {
    const s = scan(`import Chart, { readKey, encrypt as enc } from 'openpgp';
export async function f(a: string, b: boolean) {
  const [x, y] = await Promise.all([readKey({ armoredKey: a }), enc({}) as Promise<unknown>]);
  return b ? Chart() : readKey({ armoredKey: a });
}`);
    expect(s.problems).toEqual([]);
    expect([...s.lazy[0]!.names].sort()).toEqual(['default', 'encrypt', 'readKey']);
  });

  test('a sync function of the package is fine once awaited', () => {
    expect(problems(`import * as marked from 'chart.js';\nexport const html = async (md: string) => await marked.parse(md);`)).toEqual([]);
  });
});

describe('type-only uses', () => {
  test('`import type`, type specifiers and types of a value import are no use', () => {
    const s = scan(`import type * as T from 'openpgp';
import { type PrivateKey, readKey } from 'openpgp';
import * as openpgp from 'openpgp';
let k: openpgp.PrivateKey | T.Key | PrivateKey;
function f(x: openpgp.UserID): openpgp.Key { return x as unknown as openpgp.Key; }
export async function g(a: string) { return readKey({ armoredKey: a }); }`);
    expect(s.problems).toEqual([]);
    expect(s.lazy.map((x) => [...x.names])).toEqual([['readKey'], []]);
    // a type-only import is no edge
    expect(s.imports).toEqual(['openpgp', 'openpgp']);
  });
});

describe('SN324: what a stub cannot serve', () => {
  test.each([
    ['a call nothing waits for', `import * as openpgp from 'openpgp';\nexport function f() { openpgp.encrypt({}); }`, /`openpgp\.encrypt\(…\)` is not awaited/],
    ['a call assigned without await', `import { readKey } from 'openpgp';\nexport function f() { const k = readKey({}); return k; }`, /`readKey\(…\)` is not awaited/],
    ['`new`', `import Chart from 'chart.js';\nexport function f(c: HTMLCanvasElement) { return new Chart(c, {}); }`, /`Chart` needs chart\.js loaded at once/],
    ['`instanceof`', `import * as openpgp from 'openpgp';\nexport const f = (k: unknown) => k instanceof openpgp.PrivateKey;`, /`openpgp\.PrivateKey` needs openpgp loaded at once/],
    ['a constant', `import * as openpgp from 'openpgp';\nexport const algo = openpgp.enums.symmetric.aes256;`, /`openpgp\.enums` needs/],
    ['a setting', `import * as openpgp from 'openpgp';\nopenpgp.config.aeadProtect = true;`, /`openpgp\.config` needs/],
    ['a function passed as a value', `import * as openpgp from 'openpgp';\nexport const f = (a: string[]) => a.map(openpgp.readKey as never);`, /`openpgp\.readKey` needs/],
    ['the namespace passed around', `import * as openpgp from 'openpgp';\nexport const lib = openpgp;`, /`openpgp` needs/],
    ['an optional call', `import * as openpgp from 'openpgp';\nexport const f = async () => await openpgp.encrypt?.({});`, /`openpgp\.encrypt` needs/],
    ['an import for side effects', `import 'openpgp';`, /runs the package for its side effects/],
    ['a re-export', `export { readKey } from 'openpgp';`, /re-exporting `openpgp`/],
    ['a re-export of everything', `export * from 'openpgp/lightweight';`, /re-exporting `openpgp\/lightweight`/],
  ])('%s', (_, code, message) => {
    expect(problems(code).join('\n')).toMatch(message);
  });

  test('type re-exports are fine', () => {
    expect(problems(`export type { PrivateKey } from 'openpgp';\nexport type * from 'openpgp';`)).toEqual([]);
  });

  test('a dynamic import of the package is the app\'s own split, left alone', () => {
    expect(problems(`export const f = async () => { const { Chart } = await import('chart.js'); return new Chart(null as never, {} as never); };`)).toEqual([]);
  });
});

describe('rewriting', () => {
  test('only the specifier changes: lines stay, each importer gets the stubs it calls', () => {
    const code = `import * as openpgp from 'openpgp';\nimport { x } from './x.js';\nexport const f = async () => openpgp.encrypt({});\n`;
    const out = rewriteLazy(code, scan(code));
    expect(out).toBe(`import * as openpgp from "/@sinter/lazy/openpgp.js?n=encrypt";\nimport { x } from './x.js';\nexport const f = async () => openpgp.encrypt({});\n`);
  });

  test('the generated modules', () => {
    expect(parseLazyId(stubId('openpgp/lightweight', ['b', 'a', 'delete']))).toEqual({ spec: 'openpgp/lightweight', names: ['a', 'b', 'delete'] });
    expect(parseLazyId('/@sinter/lazy/@scope/pkg.js')).toEqual({ spec: '@scope/pkg', names: null });
    const m = stubModule('openpgp', ['encrypt', 'default', 'delete', 'odd-name']);
    expect(m).toContain('import { load } from "/@sinter/lazy/openpgp.js";');
    expect(m).toContain('const $0 = (...a) => load().then((m) => m["encrypt"](...a));');
    expect(m).toContain('export { $0 as encrypt, $1 as default, $2 as delete, $3 as "odd-name" };');
  });
});

describe('the app\'s imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'sinter-lazy-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  put('src/sinter.helpers.ts', `export { fmt } from './lib/fmt.ts';\nexport type { Key } from './lib/types.ts';`);
  put('src/lib/fmt.ts', `import { mime } from './mime';\nexport const fmt = (s: string) => mime(s);`);
  put('src/lib/mime.ts', `import { armor } from './pgp.js';\nexport const mime = (s: string) => s;`);
  put('src/lib/pgp.ts', `import * as openpgp from 'openpgp';\nexport const armor = async (s: string) => openpgp.readMessage({ armoredMessage: s });`);
  put('src/lib/types.ts', `import * as openpgp from 'openpgp';\nexport type Key = openpgp.Key;\nopenpgp.config.x = 1;`);
  put('src/components/task-ring.html', '<template data-sn-component=""><canvas></canvas></template>');
  put('src/components/task-ring.ts', `import Chart from 'chart.js';\nexport class TaskRing { c = new Chart(null as never, {} as never); }`);

  test('the shortest chain to a package, through the app\'s static value imports', () => {
    const r = reachLazy(join(root, 'src/sinter.helpers.ts'), ['openpgp'], root);
    expect(r.map((x) => [x.spec, x.chain.map((f) => f.slice(root.length + 1))])).toEqual([['openpgp', ['src/sinter.helpers.ts', 'src/lib/fmt.ts', 'src/lib/mime.ts', 'src/lib/pgp.ts']]]);
  });

  test('sinter check: problems in the app\'s modules, the helpers that reach a package; component scripts may use it', () => {
    const d = lazyDiagnostics(root, ['openpgp', 'chart.js'], [join(root, 'src/sinter.helpers.ts'), null], join(root, 'src/sinter.helpers.ts'), [join(root, 'src/components/task-ring.ts')]);
    expect(d.map((x) => `${x.file.slice(root.length + 1)}:${x.line} ${x.message.slice(0, 60)}`)).toEqual([
      'src/sinter.helpers.ts:1 the helpers module reaches openpgp, which `sinter({ lazy })`',
    ]);
    expect(d[0]!.message).toContain('src/sinter.helpers.ts → src/lib/fmt.ts → src/lib/mime.ts → src/lib/pgp.ts → openpgp');
    // the types module's misuse is not reached (type-only re-export): put it in the graph
    const d2 = lazyDiagnostics(root, ['openpgp'], [join(root, 'src/lib/types.ts')], null, []);
    expect(d2.map((x) => `${x.line}:${x.col} ${x.code}`)).toEqual(['3:1 SN324']);
  });

  test('the option takes package names', () => {
    expect(lazyOf(['openpgp', '@scope/x', 'openpgp'])).toEqual(['openpgp', '@scope/x']);
    expect(() => lazyOf('openpgp')).toThrow(/takes a list/);
    expect(() => lazyOf(['./src/x.ts'])).toThrow(/is not a package name/);
    expect(() => lazyOf(['openpgp/lightweight'])).toThrow(/covered by its package/);
  });
});

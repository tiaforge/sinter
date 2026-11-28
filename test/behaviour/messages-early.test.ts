// @vitest-environment node
// The texts in the early script (docs/messages.md#messages-in-the-early-script): `inlineTexts` replaces a module's
// message uses by what the messages module would make of them, in the page's language. Checked against the module
// itself: each expression is run twice, as written over the messages module and its dictionary, and as rewritten with
// no messages module at all; the results, the errors thrown and the order of every side effect must be the same.
import { expect, test } from 'vitest';
import { m as runtimeM, state } from '../../src/messages.js';
import { inlineTexts } from '../../src/i18n-build.js';

/** the page's dictionary, as a build writes it (packed: a plain message is its text; a plural is not) */
const DICT: Record<string, unknown> = {
  plain: 'Plain text',
  hello: 'Hello {name}!',
  two: '{a} and {b}',
  twice: '{n} of {n}',
  weird: 'Quote " single \' back \\ nl \n tab \t tpl ${x} `tick` </script> <!-- \u2028 \u2029 😀 שלום עולם {n} $& $1 $$ \0 end',
  ctor: 'C {constructor} {toString} {x}',
  dash: 'D {user-name} {n}',
  'nested.title': 'Nested title',
  strict: 'use strict',
  empty: '',
  only: '{n}',
  plural: { s: [{ n: 'count', f: 'plural' }], v: [[['one'], ['one']], [['*'], [{ v: 'count' }, ' many']]] },
};
const CASES = [
  'm.plain()', "m.plain(log('a'))", "m.plain(log('a'), log('b'))", 'm.plain(...[1, 2])', 'm.plain((log(1), log(2)))',
  'm.hello()', "m.hello({ name: 'x' })", 'm.hello({ name: x })', "m.hello({ name: log('n') })", "m.hello({ 'name': 1.50 })",
  'm.hello({ name: null })', 'm.hello({ name: true })', 'm.hello({ name: 10n })', "m.hello({ name: Symbol('s') })",
  'm.hello({ name: undefined })', 'm.hello({})', 'm.hello(null)', 'm.hello(0)', "m.hello('')", 'm.hello(5)', "m.hello('str')",
  "m.hello({ name: { toString() { log('ts'); return 'T'; }, valueOf() { log('vo'); return 'V'; } } })",
  'm.hello(params)', 'm.hello({ ...params })', "m.hello({ name: 'a' }, log('extra'))", "m.hello({ get name() { log('get'); return 'g'; } })",
  "m.hello({ __proto__: { name: 'proto' } })", "m.hello({ ['na' + 'me']: 'c' })", "m.hello({ name: 'a', name: log('b') })",
  "m.hello({ name() { return 1; } })", "m.hello({ name: 'x', other: log('unused') })", "m.hello({ name: 'x', other: 'unused' })",
  "m.two({ a: log('A'), b: log('B') })", "m.two({ b: log('B'), a: log('A') })", 'm.two({ a: 1, b: x })', "m.two({ a: 'one' })",
  "m.twice({ n: { toString() { log('ts'); return 'T'; } } })", "m.twice({ n: 'z' })", "m.weird({ n: '<' })", 'm.weird()', 'm.weird({ n: x })',
  'm.ctor({})', "m.ctor({ constructor: 'c', toString: 't', x: 1 })", "m.ctor({ x: 1 })", "m.dash({ n: 1, 'user-name': 2 })",
  'm.nested.title()', 'm.hello`tag ${1}`', "m.hello?.({ name: 'o' })", "m?.hello({ name: 'o2' })", "(m.hello)({ name: 'p' })",
  'm.hello({ name: m.plain() })', "m.two({ a: m.hello({ name: 'in' }), b: m.plain() })", 'm.empty()', 'm.only({ n: 7 })', 'm.only({ n: x })',
  'm.plural({ count: 1 })', 'new m.plain()', 'typeof m.plain', 'delete m.plain', "[m.hello].map((f) => f({ name: 'r' }))",
  "(() => { const f = m.hello; return [f(), f({ name: 'f' }), f(0)]; })()", 'm.strict()', 'm.plain().length', '`${m.hello({ name: 1 })}`',
];

/** one module, run with or without the messages module: each case's result (or error), and the side effects in order */
const run = (code: string, withM: boolean) => {
  const body = code.replace(/^import \{ m \} from '@tiaforge-ui\/sinter\/messages';\n/m, '').replace(/^export /gm, '');
  const out: unknown[] = [];
  const log = (x: unknown) => { out.push(['log', x]); return x; };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const cases = new Function('m', 'log', 'x', 'params', `${body}\nreturn cases;`)(withM ? runtimeM : new Proxy({}, { get: (_, k) => (k === 'plural' ? (runtimeM as any).plural : undefined) }), log, { toString: () => 'X' }, { name: 'P' }) as Array<() => unknown>;
  for (const c of cases) {
    try {
      const v = c();
      out.push(typeof v === 'function' ? ['fn', String(v({ name: 'call' }))] : typeof v === 'symbol' || typeof v === 'bigint' ? String(v) : v);
    } catch (e) { out.push(['throws', (e as Error).constructor.name, (e as Error).message.replace(/^.* is not a constructor$/, 'not a constructor')]); }
  }
  return out;
};
const source = (cases: string[]) => `import { m } from '@tiaforge-ui/sinter/messages';\nfunction strict(a = 1) { m.strict(); return a; }\nexport const cases = [\n${cases.map((c) => `  () => ${c},`).join('\n')}\n  () => strict(),\n];\n`;

test('every shape: the rewritten module gives what the messages module gives, with the same side effects in the same order', () => {
  const s = state();
  s.locale = s.base = 'de'; s.locales = ['de']; s.dicts = { de: { ...DICT } };
  s.format = (e, p) => `formatted ${JSON.stringify(e)} ${JSON.stringify(p)}`;
  const code = source(CASES);
  const x = inlineTexts(code, 'probe.ts', (k) => DICT[k])!;
  expect(x).not.toBeNull();
  // (the plural is left: it reads the dictionary; everything else is gone from the module)
  expect(x.left).toEqual(['plural']);
  expect(x.code.match(/\bm\./g)).toHaveLength(1);
  expect(run(x.code, false).map(String)).toEqual(run(code, true).map(String));
  expect(JSON.stringify(run(x.code, false), (_, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(JSON.stringify(run(code, true), (_, v) => (typeof v === 'bigint' ? String(v) : v)));
});

test('the smallest form where it is exact: the text itself, a concatenation, a function only where it must', () => {
  const one = (c: string) => inlineTexts(`import { m } from '@tiaforge-ui/sinter/messages';\nexport const v = ${c};\n`, 'a.ts', (k) => DICT[k])!.code.split('\n')[1];
  expect(one('m.plain()')).toBe('export const v = ("Plain text");');
  expect(one("m.plain(log('a'))")).toBe('export const v = ((log(\'a\')),"Plain text");');
  expect(one('m.hello({ name: who })')).toBe('export const v = ("Hello "+String(who)+"!");');
  expect(one("m.two({ a: 1, b: 'x' })")).toBe('export const v = ("1 and x");');
  expect(one('m.weird()')).toContain('\\u003c/script> \\u003c!-- \\u2028 \\u2029');
  // two values that are not literals: a function, so each is evaluated before either is turned into a text
  expect(one('m.two({ a, b })')).toMatch(/^export const v = \(\(p=>p\?/);
  expect(one('m.hello(params)')).toBe('export const v = ((p=>p?"Hello "+("name" in p?String(p["name"]):"{name}")+"!":"Hello {name}!")((params)));');
});

test('left as written: another binding of the name, `String` of the module\'s own, a write, a property of a message', () => {
  const t = (code: string) => inlineTexts(`import { m } from '@tiaforge-ui/sinter/messages';\n${code}\n`, 'a.ts', (k) => DICT[k]);
  expect(t('export const a = m.plain(); export function f(m) { return m.plain(); }')).toBeNull();
  expect(t('export const a = m.plain(); { const m = { plain: () => 1 }; m.plain(); }')).toBeNull();
  expect(t('export const a = m.plain(); export { m };')).toBeNull();
  expect(t('const String = (x) => x; export const a = m.hello({ name: 1 });')).toBeNull();
  expect(t('export function f({ String }) { return String; } export const a = m.plain();')).toBeNull();
  const w = t('export const a = m.plain(); m.hello = 1; export const b = m.hello.length; export const c = m.plain[\'x\'];')!;
  expect(w.left).toEqual(['hello', 'hello.length', 'plain']);
  expect(w.code).toContain('m.hello = 1');
  expect(w.code).toContain("m.plain['x']");
  // an entry the page does not have, or one that is not a text
  expect(t('export const a = m.gone();')).toBeNull();
  // `ref: null` (the second build): a reference is left
  expect(inlineTexts("import { m } from '@tiaforge-ui/sinter/messages';\nexport const a = [m.plain, m.plain()];\n", 'a.ts', (k) => DICT[k], { ref: null })!.code).toContain('[m.plain, ("Plain text")]');
});

test('code without semicolons: a statement that starts with a message stays a statement of its own', () => {
  // (each line after `b` would continue `b`'s statement if it started with `(`: a call of `b`, a template tag)
  const code = "import { m } from '@tiaforge-ui/sinter/messages'\nconst b = (...a) => log(['called', ...a])\nlet v = b\nm.plain()\nv = b\nm.hello`t`\nv = b\nm.plain\nv = b\nm.hello({ name: 1 }).length\nfunction f() {\n  v = b\n  m.plural({ count: 1 })\n  return v\n}\nf()\nif (v) m.plain()\nelse m.hello()\nexport const cases = [() => v]\n";
  const x = inlineTexts(code, 'asi.ts', (k) => DICT[k], { before: () => 'log("before")' })!;
  expect(x.code).not.toMatch(/\n\(/);
  const s = state();
  s.locale = s.base = 'de'; s.locales = ['de']; s.dicts = { de: { ...DICT } };
  s.format = (e, p) => `formatted ${JSON.stringify(e)} ${JSON.stringify(p)}`;
  const strip = (c: string) => c.replace(/^import \{ m \} from '@tiaforge-ui\/sinter\/messages'\n/m, '');
  const as = (c: string, withM: boolean) => {
    const out: unknown[] = [];
    const log = (v: unknown) => { out.push(v); return v; };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('m', 'log', `${strip(c).replace(/^export /gm, '')}\nreturn cases;`)(withM ? runtimeM : new Proxy({}, { get: (_, k) => (runtimeM as any)[k] }), log);
    return out;
  };
  // (the rewritten module logs its `before` once more: the formatter's registration, which the messages module does as it loads)
  expect(as(x.code, false).filter((v) => v !== 'before')).toEqual(as(code, true));
});

test('`String` imported is the module\'s own: nothing is written in', () => {
  for (const imp of ["import { String } from './s';", "import String from './s';", "import * as String from './s';", "import { S as String } from './s';"]) {
    expect(inlineTexts(`import { m } from '@tiaforge-ui/sinter/messages';\n${imp}\nexport const a = m.hello({ name: x });\n`, 'a.ts', (k) => DICT[k])).toBeNull();
  }
  // a type of that name is no value
  expect(inlineTexts("import { m } from '@tiaforge-ui/sinter/messages';\nimport type { String } from './s';\nexport const a = m.hello({ name: x });\n", 'a.ts', (k) => DICT[k])).not.toBeNull();
});

test('TypeScript: casts, non-null assertions, types and namespaces', () => {
  const code = `import { m } from '@tiaforge-ui/sinter/messages';\ntype T = ReturnType<typeof m.plain>;\nexport const a = (m.plain as () => string)();\nexport const b = m.hello!({ name: 'n' as string });\nexport namespace N { export const c: string = m.plain(); }\nexport enum E { D = m.plain().length }\n`;
  const x = inlineTexts(code, 'a.ts', (k) => DICT[k])!;
  expect(x.left).toEqual([]);
  expect(x.code).toContain('typeof m.plain>');
  expect(x.code).toContain('const a = ("Plain text")');
  expect(x.code).toContain("const b = (\"Hello \"+String('n' as string)+\"!\")");
  expect(x.code).toContain('const c: string = ("Plain text")');
});

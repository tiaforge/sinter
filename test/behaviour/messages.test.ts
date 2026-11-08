// Built-in messages: `m.key()` in markup and app code, `{param}`s, the base language for missing
// translations, `$locale` switching without a reload; and the build side (inlang files, types, keys per module).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { firstPaint, memoryStorage, render } from '@tiaforge-ui/sinter/testing';
import { m } from '../../src/messages.js';
import { messagesDts, moduleKeys, readMessages } from '../../src/i18n-build.js';

const messages = {
  en: { title: 'People', hello: 'Hello {name}', only_en: 'Only in English' },
  de: { title: 'Leute', hello: 'Hallo {name}' },
};
const page = `<body data-sn-state="{ who: 'Ada', lang: $locale }">
  <h1 data-sn-text="m.title()"></h1>
  <p data-sn-text="m.hello({ name: who })"></p>
  <p data-sn-text="m.only_en()"></p>
  <select data-sn-model="lang" data-sn-on-change="$locale = lang"><option>en</option><option>de</option></select>
</body>`;
const texts = () => [...document.querySelectorAll('h1, p')].map((e) => e.textContent);

afterEach(() => { try { localStorage.clear(); } catch { /* none */ } });

test('m.key() with {param}s, in the stored language; a missing translation is the base language', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  await render(page, { messages, storage });
  expect(texts()).toEqual(['Leute', 'Hallo Ada', 'Only in English']);
  expect(document.documentElement.lang).toBe('de');
});

test('$locale = \'en\' switches without a reload: stored, <html lang>, every message re-rendered', async () => {
  const { root, flush, navigations } = await render(page, { messages, locale: 'de' });
  const select = root.querySelector('select')!;
  select.value = 'en';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  await new Promise((r) => setTimeout(r, 0));
  await flush();
  expect(texts()).toEqual(['People', 'Hello Ada', 'Only in English']);
  expect(document.documentElement.lang).toBe('en');
  expect(localStorage.getItem('locale')).toBe('en');
  expect(navigations).toEqual([]);
});

test('app code reads the same dictionary through `m` from the messages module', async () => {
  await render(page, { messages, locale: 'de' });
  expect((m as unknown as { hello(p: { name: string }): string }).hello({ name: 'Bo' })).toBe('Hallo Bo');
});

test('first paint: the early step renders messages in the visitor\'s language', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  await firstPaint(page, { messages, storage });
  expect(texts()).toEqual(['Leute', 'Hallo Ada', 'Only in English']);
});

test('unknown messages are build errors with a suggestion', async () => {
  await expect(render('<p data-sn-text="m.titel()"></p>', { messages })).rejects.toThrow(/SN206.*`m\.titel` is not exported.*title/s);
});

test('modules: `m.key` is collected; `m[key]` and passing `m` on are refused', () => {
  const src = `import { m } from '@tiaforge-ui/sinter/messages';\nexport const a = () => m.title() + m.hello({ name: 'x' });\n`;
  expect(moduleKeys(src, '/a.ts')).toEqual({ keys: ['hello', 'title'], errors: [] });
  expect(moduleKeys(`import { m as t } from '@tiaforge-ui/sinter/messages';\nexport const b = (k: string) => (t as any)[k]();\n`, '/b.ts').errors[0]).toMatch(/\/b\.ts:2:\d+: `t` is used other than as `t\.key`/);
  expect(moduleKeys(`import { m } from '@tiaforge-ui/sinter/messages';\nexport const c = (k) => m[k]();\n`, '/c.js').errors[0]).toMatch(/\/c\.js:2:\d+: `m\[…\]`/);
  expect(moduleKeys(`export const m = { x: 1 };\nm.x;\n`, '/d.js')).toEqual({ keys: [], errors: [] });
});

test('the inlang project: locales, base, path pattern; types from the base language\'s placeholders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinter-inlang-'));
  try {
    mkdirSync(join(dir, 'project.inlang'));
    mkdirSync(join(dir, 'msg'));
    writeFileSync(join(dir, 'project.inlang/settings.json'), JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'], 'plugin.inlang.messageFormat': { pathPattern: './msg/{locale}.json' } }));
    writeFileSync(join(dir, 'msg/en.json'), JSON.stringify({ $schema: 'x', a: 'A', b: 'Hi {name}, {count} new', c: { plural: true } }));
    writeFileSync(join(dir, 'msg/de.json'), JSON.stringify({ a: 'Ä' }));
    const p = readMessages(dir)!;
    expect(p.base).toBe('en');
    expect(p.locales).toEqual(['en', 'de']);
    expect(p.keys).toEqual({ a: [], b: ['name', 'count'] });
    expect(p.diagnostics.map((d) => d.message)).toEqual(['message `c` (en) is not a plain string: sinter\'s messages have no plurals or variants yet']);
    const dts = messagesDts(p);
    expect(dts).toContain('    a(): string;');
    expect(dts).toContain('    b(params: { name: string | number; count: string | number }): string;');
    expect(readMessages(join(dir, 'msg'))).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

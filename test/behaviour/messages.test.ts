// Built-in messages: `m.key()` in markup and app code, `{param}`s, the base language for missing translations, a
// page in one language (`$locale` cannot be written); and the build side (inlang files, types, keys per module).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { firstPaint, render } from '@tiaforge-ui/sinter/testing';
import { m } from '../../src/messages.js';
import { messagesDts, moduleKeys, readMessages } from '../../src/i18n-build.js';

const messages = {
  en: { title: 'People', hello: 'Hello {name}', only_en: 'Only in English' },
  de: { title: 'Leute', hello: 'Hallo {name}' },
};
const page = `<body data-sn-state="{ who: 'Ada' }">
  <h1 data-sn-text="m.title()"></h1>
  <p data-sn-text="m.hello({ name: who })"></p>
  <p data-sn-text="m.only_en()"></p>
  <p data-sn-text="$locale"></p>
</body>`;
const texts = () => [...document.querySelectorAll('h1, p')].map((e) => e.textContent);

test('m.key() with {param}s, in the page\'s language; a missing translation is the base language', async () => {
  await render(page, { messages, locale: 'de' });
  expect(texts()).toEqual(['Leute', 'Hallo Ada', 'Only in English', 'de']);
  await render(page, { messages });
  expect(texts()).toEqual(['People', 'Hello Ada', 'Only in English', 'en']);
});

test('a page has one language: writing `$locale` is SN203', async () => {
  await expect(render('<button data-sn-on-click="$locale = \'en\'">en</button>', { messages, locale: 'de' }))
    .rejects.toThrow(/SN203.*`\$locale` is this page's language \(`de`/s);
});

test('app code reads the same dictionary through `m` from the messages module', async () => {
  await render(page, { messages, locale: 'de' });
  expect((m as unknown as { hello(p: { name: string }): string }).hello({ name: 'Bo' })).toBe('Hallo Bo');
});

test('first paint: the early step renders messages in the page\'s language', async () => {
  await firstPaint(page, { messages, locale: 'de' });
  expect(texts()).toEqual(['Leute', 'Hallo Ada', 'Only in English', 'de']);
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

test('the messages as a namespace: install() reads the page\'s entries, `m.inbox.unread()` formats one', async () => {
  const { install, state } = await import('../../src/messages.js');
  const { format } = await import('../../src/messages/format.js');
  const { parseComplex } = await import('../../src/messages/content.js');
  const unread = parseComplex([{ declarations: ['local n = count: plural'], selectors: ['n'], match: { 'n=one': '{count} Nachricht', 'n=*': '{count} Nachrichten' } }], 'x');
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
  document.body.innerHTML = `<script type="application/json" data-sn-ns="m">${JSON.stringify({ 'inbox.unread': { id: 'inbox.unread', m: unread } })}</script>`;
  install('de', format as never);
  const mm = m as unknown as { inbox: { unread(p: { count: number }): string } };
  expect([mm.inbox.unread({ count: 1 }), mm.inbox.unread({ count: 3 })]).toEqual(['1 Nachricht', '3 Nachrichten']);
  expect(state().locale).toBe('de');
});

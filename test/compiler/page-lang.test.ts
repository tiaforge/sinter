// An app that sets no locale (no `languages()`, no `localePrefix`, no `configure({ locale })`): the page's literal
// `<html lang>` (its layout's included) is the locale of the built-in formatters and `$locale`, at build (what the HTML
// has) and in the browser (`$lang` in the page module and the early file). No lang, a bound one or one `Intl` refuses,
// or an app that configures its locale: as before.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { configuresLocale } from '../../src/project.js';

const build = (html: string, more: Record<string, unknown> = {}, files: Record<string, string> = {}) => compile(html, {
  file: '/p/index.html', root: '/p', dev: false, prerender: true, early: { module: null },
  // a build with the helpers loaded, where `$locale` counts as fixed (as `render()` compiles)
  helpers: { module: null, names: [], namespaces: {} }, helperValues: {}, helperFold: new Map(),
  readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`missing ${p}`); },
  ...more,
} as never);
const STATE = '<div data-sn-state="{ n: 1234.5, day: \'2026-11-11\' }"><p data-sn-text="number(n)"></p><p data-sn-text="date(day, \'long\')"></p></div>';
const page = (html: string, body = STATE) => `<!doctype html>${html}<head><title>x</title></head><body>${body}</body></html>`;

describe('<html lang> in an app without languages', () => {
  test('number() and a calendar date are written in the page\'s language at build time', () => {
    const out = build(page('<html lang="de">'));
    expect(out.diagnostics).toEqual([]);
    expect(out.html).toContain('<p>1.234,5</p><p>11. November 2026</p>');
  });

  test('the page module and the early file set the language before anything formats', () => {
    // a moment and a number over data: written in the browser
    const body = '<script type="application/json" data-sn-resource="a">{"at":"2026-11-11T09:00:00Z","n":1234.5}</script><sn-resource name="a" src="/api/a"></sn-resource><p data-sn-text="date(a.at)"></p><p data-sn-text="number(a.n)"></p><p data-sn-text="$locale"></p>';
    const out = build(page('<html lang="de-AT">', body));
    expect(out.diagnostics).toEqual([]);
    expect(out.module).toMatch(/import \{[^}]*\$lang[^}]*\} from '@tiaforge-ui\/sinter\/runtime';\n\$lang\("de-AT"\);/);
    // the early file: its formatters' locale, and `$locale` from the page object (the head script's runtime is shared)
    expect(out.early).toContain('$lang("de-AT");');
    expect(out.early).toContain('locale: () => ({ get: () => "de-AT" })');
    expect(out.early).not.toMatch(/import \{[^}]*\blocale\b[^}]*\} from '@tiaforge-ui\/sinter\/runtime\/early'/);
    // `$locale` stays a value of the browser (an app's `configure({ locale })` may switch it): not written at build
    expect(out.html).not.toContain('>de-AT<');
  });

  test('the layout\'s <html lang> counts', () => {
    const layout = '<!doctype html><html lang="fr"><head><title>x</title></head><body><slot></slot></body></html>';
    const out = build('<main-layout>' + STATE + '</main-layout>', {}, { '/p/src/layouts/main-layout.html': layout });
    expect(out.diagnostics).toEqual([]);
    expect(out.html).toMatch(/<p>1 234,5<\/p><p>11 novembre 2026<\/p>/);
  });

  test('a layout\'s tag that binds lang: not the page\'s locale', () => {
    const layout = '<!doctype html><html lang="fr" data-sn-props="{ l?: string }"><head><title>x</title></head><body><slot></slot></body></html>';
    for (const tag of ['<main-layout data-sn-attr="{ lang: $url.l }">', '<main-layout data-sn-attr="{ lang: \'de\' }">']) {
      const out = build(tag + STATE + '</main-layout>', {}, { '/p/src/layouts/main-layout.html': layout });
      expect(out.diagnostics, tag).toEqual([]);
      expect(out.module, tag).not.toContain('$lang');
      expect(out.html, tag).not.toContain('234,5');
    }
  });

  test('a page that reads no locale (no formatter, no `$locale`, no component script) sets none', () => {
    const out = build(page('<html lang="de">', '<div data-sn-state="{ n: 1 }"><button data-sn-on-click="n++">+</button><b data-sn-text="n"></b></div>'));
    expect(out.diagnostics).toEqual([]);
    expect(out.module).not.toContain('$lang');
    expect(out.early ?? '').not.toContain('$lang');
    expect(out.early ?? '').not.toContain('locale');
  });

  test('dev builds: text formatted in the page\'s language is recorded for the dev module\'s check (warning 35)', () => {
    expect(build(page('<html lang="de">'), { dev: true }).module).toContain('"lf":"de"');
    expect(build(page('<html lang="de">')).module).not.toContain('"lf"');
    expect(build(page('<html lang="de">'), { dev: true, appLocale: true }).module).not.toContain('"lf"');
  });

  test('an app that configures its locale (`configure({ locale })`): the attribute is not used, not even at build', () => {
    const out = build(page('<html lang="de">'), { appLocale: true });
    expect(out.module).not.toContain('$lang');
    expect(out.early ?? '').not.toContain('$lang');
    expect(out.html).not.toContain('1.234,5');
  });

  test('no lang, a bound lang, a lang Intl refuses: no page locale (the engine\'s default, in the browser)', () => {
    const bound = ['{ lang: \'de\' }', '{ lang }', '{ \'lang\': x }'].map((a) => `<html lang="de" data-sn-attr="${a}" data-sn-state="{ lang: 'de', x: 'de' }">`);
    for (const html of ['<html>', '<html lang="">', ...bound, '<html lang="en_US">']) {
      const out = build(page(html));
      expect(out.diagnostics.filter((d) => d.severity === 'error'), html).toEqual([]);
      expect(out.module, html).not.toContain('$lang');
      expect(out.early ?? '', html).not.toContain('$lang');
      // the formatters wait for the browser
      expect(out.html, html).not.toContain('1.234,5');
    }
  });

  test('an app with languages: its language, not the attribute', () => {
    const out = build(page('<html lang="fr">'), { locale: { name: 'de', urls: null, base: '/', prefix: false } });
    expect(out.html).toContain('<p>1.234,5</p><p>11. November 2026</p>');
    expect(out.module).toContain('$lang("de");');
    expect(out.module).not.toContain('$lang("fr")');
  });
});

describe('whether the app sets its locale (src/project.ts: the config and early modules, and the app modules they import)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinter-configures-locale-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  /** writes `files` (the first is the config module) into a fresh folder; whether it sets a locale */
  const sets = (files: Record<string, string>) => {
    const root = join(dir, String(n++));
    for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
    return configuresLocale(join(root, Object.keys(files)[0]!), root);
  };
  const config = (body: string) => ({ 'src/sinter.config.js': `import { configure } from '@tiaforge-ui/sinter';\n${body}\n` });

  test('a locale key, in any form, a spread or a variable as the options, an assignment to .locale', () => {
    for (const body of ["configure({ locale: { get: () => l, set() {} } });", 'const locale = source();\nconfigure({ locale });',
      "configure({ 'locale': src });", 'configure({ "locale": src });', "configure({ sessionProbe: 'https://a/b', locale: src });",
      'configure({ ...i18n });', 'configure(options);', 'config.locale = src;']) expect(sets(config(body)), body).toBe(true);
    expect(sets({ 'src/sinter.config.js': "import { configure as setup } from '@tiaforge-ui/sinter';\nsetup({ ...i18n });\n" })).toBe(true);
  });

  test('through an app module the config module imports (a paraglide setup)', () => {
    expect(sets({ ...config("import './i18n.js';\nconfigure({ origins: [] });"), 'src/i18n.js': "import { configure } from '@tiaforge-ui/sinter';\nimport { getLocale, setLocale } from './paraglide/runtime.js';\nconfigure({ locale: { get: getLocale, set: setLocale } });\n", 'src/paraglide/runtime.js': 'export const getLocale = () => "fr", setLocale = () => {};\n' })).toBe(true);
    expect(sets({ ...config("import { base } from './base.js';\nconfigure({ origins: [base] });"), 'src/base.js': "export const base = 'https://api.example.com';\n" })).toBe(false);
  });

  test('none: other options, a comment, another word, a module that cannot be parsed counts', () => {
    for (const body of ['configure({ origins: [] });', '// configure({ locale: x })\nconfigure({ origins: [] });', "configure({ onError: (e) => console.log(e.toLocaleString(), '//') });"]) expect(sets(config(body)), body).toBe(false);
    expect(sets(config('configure({ origins: [ });'))).toBe(true);
  });
});

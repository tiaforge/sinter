import { expect, test } from 'vitest';
import { firstPaint, memoryStorage, mockRequests, render } from '@tiaforge-ui/sinter/testing';
import page from './first-paint.html?raw';

// the app's messages (paraglide, say), switched per locale at build time by `locale.use`
let lang = 'en';
const text: Record<string, Record<string, string>> = {
  en: { nav: 'Main navigation', collapse: 'Collapse menu', mail: 'Mail', calendar: 'Calendar' },
  de: { nav: 'Hauptnavigation', collapse: 'Menü einklappen', mail: 'E-Mail', calendar: 'Kalender' },
};
const m = Object.fromEntries(Object.keys(text.en!).map((k) => [k, () => text[lang]![k]!]));
// vite.config.ts: sinter({ locale: { locales: ['en', 'de'], storage: 'locale', use: 'src/paraglide/runtime.js#setLocale' } })
const locale = { locales: ['en', 'de'], storage: 'locale', use: (l: string) => { lang = l; } };

test('before the page module: labels in the visitor\'s locale, the current page, the persisted collapse', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  storage.setItem('sn:nav-collapsed', 'true');
  const { root } = await firstPaint(page, { helpers: { m }, locale, storage });
  expect(document.documentElement.lang).toBe('de');  // the app starts its i18n from <html lang>
  expect([...root.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('aria-current')])).toEqual([['E-Mail', 'page'], ['Kalender', null]]);
  expect(root.querySelector('input')!.checked).toBe(true);
  expect(root.querySelector('nav > span')).toBeNull();  // the user's name waits for its data
});

test('the page module takes over without changing what was shown, then fills in data', async () => {
  const storage = memoryStorage();
  storage.setItem('sn:nav-collapsed', 'true');
  await firstPaint(page, { helpers: { m }, locale, storage, languages: ['de-AT'] });
  const shown = document.querySelector('nav')!.outerHTML;
  const requests = mockRequests({ 'GET /api/user': { name: 'Ada' } });
  const { root, settle } = await render(page, { helpers: { m }, storage, requests, firstPaint: { locale, languages: ['de-AT'] } });
  expect(root.querySelector('nav')!.outerHTML).toBe(shown);
  await settle();
  expect(root.querySelector('nav')!.textContent).toContain('Ada');
  expect(root.querySelector('input')!.checked).toBe(true);
});

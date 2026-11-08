import { expect, test } from 'vitest';
import { firstPaint, memoryStorage, mockRequests, render } from '@tiaforge-ui/sinter/testing';
import page from './first-paint.html?raw';

// the app's messages (paraglide, say) and its src/sinter.early.ts, which picks the language before anything renders:
//   const lang = (localStorage.getItem('locale') || navigator.language).slice(0, 2);
//   setLocale(lang, { reload: false }); document.documentElement.lang = lang;
let lang = 'en';
const text: Record<string, Record<string, string>> = {
  en: { nav: 'Main navigation', collapse: 'Collapse menu', mail: 'Mail', calendar: 'Calendar' },
  de: { nav: 'Hauptnavigation', collapse: 'Menü einklappen', mail: 'E-Mail', calendar: 'Kalender' },
};
const m = Object.fromEntries(Object.keys(text.en!).map((k) => [k, () => text[lang]![k]!]));
const early = (storage: Storage) => () => { lang = storage.getItem('locale') ?? 'en'; };

test('before the page module: labels in the visitor\'s language, the current page, the persisted collapse', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  storage.setItem('sn:nav-collapsed', 'true');
  const { root } = await firstPaint(page, { helpers: { m }, storage, early: early(storage) });
  expect([...root.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('aria-current')])).toEqual([['E-Mail', 'page'], ['Kalender', null]]);
  expect(root.querySelector('input')!.checked).toBe(true);
  expect(root.querySelector('nav > span')).toBeNull();  // the user's name waits for its data
  lang = 'en';
});

test('the page module takes over without changing what was shown, then fills in data', async () => {
  const storage = memoryStorage();
  storage.setItem('sn:nav-collapsed', 'true');
  let shown = '';
  const requests = mockRequests({ 'GET /api/user': { name: 'Ada' } });
  const { root, settle } = await render(page, {
    helpers: { m }, storage, requests,
    firstPaint: { early: early(storage), afterEarly: () => { shown = document.querySelector('nav')!.outerHTML; } },
  });
  expect(root.querySelector('nav')!.outerHTML).toBe(shown);
  await settle();
  expect(root.querySelector('nav')!.textContent).toContain('Ada');
  expect(root.querySelector('input')!.checked).toBe(true);
});

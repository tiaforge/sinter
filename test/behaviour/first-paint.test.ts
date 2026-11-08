// First paint in the browser: the first-paint script picks the locale and writes its text and the
// persisted controls; the page module then takes the page over without changing what was shown.
import { expect, test } from 'vitest';
import { firstPaint, memoryStorage, render } from '@tiaforge-ui/sinter/testing';
import { compile, FIRST_PAINT_SCRIPT, pickLocale } from '../../src/compiler/index.js';

let current = 'en';
const messages: Record<string, Record<string, string>> = {
  en: { nav: 'Main navigation', mail: 'Mail', collapse: 'Collapse menu' },
  de: { nav: 'Hauptnavigation', mail: 'E-Mail', collapse: 'Menü einklappen' },
};
const m = { nav: () => messages[current]!.nav!, mail: () => messages[current]!.mail!, collapse: () => messages[current]!.collapse! };
const locale = { locales: ['en', 'de'], storage: 'locale', use: (l: string) => { current = l; } };

const page = `<!doctype html><html lang="en"><head></head>
<body data-sn-state="{ here: '/mail/' }">
  <sn-resource name="user" src="/api/user"></sn-resource>
  <nav data-sn-attr="{'aria-label': m.nav()}" data-sn-state="{ collapsed: false }">
    <input type="checkbox" data-sn-model="collapsed" data-sn-persist="nav-collapsed" data-sn-attr="{'aria-label': m.collapse()}">
    <a href="/mail/" data-sn-attr="{'aria-current': here === '/mail/' ? 'page' : null, 'data-tooltip': m.mail()}"><span data-sn-text="m.mail()"></span></a>
    <span id="name" data-sn-text="user.name"></span>
  </nav>
</body></html>`;

const rail = () => {
  const nav = document.querySelector('nav')!, input = nav.querySelector('input')!, a = nav.querySelector('a')!;
  return { lang: document.documentElement.lang, label: nav.getAttribute('aria-label'), collapse: input.getAttribute('aria-label'), checked: input.checked, current: a.getAttribute('aria-current'), tooltip: a.dataset.tooltip, text: a.textContent };
};

test('pickLocale: the stored choice, then the browser languages (exact, then the language), then the first', () => {
  expect(pickLocale(['en', 'de'], 'de', ['en-US'])).toBe('de');
  expect(pickLocale(['en', 'de'], 'fr', ['de-AT', 'en'])).toBe('de');
  expect(pickLocale(['en', 'pt-BR', 'pt'], null, ['pt-BR'])).toBe('pt-BR');
  expect(pickLocale(['en', 'pt'], null, ['PT-br'])).toBe('pt');
  expect(pickLocale(['en', 'de'], null, ['fr', 'it'])).toBe('en');
});

test('the first paint in the fallback locale: text, current page and labels before any module has run', async () => {
  await firstPaint(page, { helpers: { m }, locale });
  expect(rail()).toEqual({ lang: 'en', label: 'Main navigation', collapse: 'Collapse menu', checked: false, current: 'page', tooltip: 'Mail', text: 'Mail' });
  expect(document.getElementById('name')!.textContent).toBe('');
});

test('the visitor\'s locale (stored, else the browser\'s) and persisted controls, before any module has run', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  storage.setItem('sn:nav-collapsed', 'true');
  await firstPaint(page, { helpers: { m }, locale, storage });
  expect(rail()).toEqual({ lang: 'de', label: 'Hauptnavigation', collapse: 'Menü einklappen', checked: true, current: 'page', tooltip: 'E-Mail', text: 'E-Mail' });

  await firstPaint(page, { helpers: { m }, locale, languages: ['de-CH', 'en'] });
  expect(rail().text).toBe('E-Mail');
  await firstPaint(page, { helpers: { m }, locale: { ...locale, navigator: false }, languages: ['de-CH'] });
  expect(rail().text).toBe('Mail');
});

test('the page module takes the first paint over without changing it', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  storage.setItem('sn:nav-collapsed', 'true');
  await firstPaint(page, { helpers: { m }, locale, storage });
  const before = rail(), html = document.querySelector('nav')!.outerHTML;
  const requests = (await import('@tiaforge-ui/sinter/testing')).mockRequests({ 'GET /api/user': { name: 'Ada' } });
  // render() starts the helpers in the locale the first-paint script picked, as the app's i18n would
  const { settle } = await render(page, { helpers: { m }, storage, requests, firstPaint: { locale } });
  expect(current).toBe('de');
  expect(rail()).toEqual(before);
  expect(document.querySelector('nav')!.outerHTML).toBe(html);
  await settle();
  expect(document.getElementById('name')!.textContent).toBe('Ada');
  expect(rail()).toEqual(before);
  current = 'en';
});

test('FIRST_PAINT_SCRIPT runs on its own as a classic script', () => {
  current = 'en';
  const out = compile(page, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: '/h.js', names: [], namespaces: { m: { module: '/m.js', members: ['nav', 'mail', 'collapse'] } } },
    firstPaint: { helpers: { m }, locale },
  });
  const doc = new DOMParser().parseFromString(out.html, 'text/html');
  document.documentElement.innerHTML = doc.documentElement.innerHTML;
  localStorage.setItem('locale', 'de');
  localStorage.setItem('sn:nav-collapsed', 'true');
  try {
    // eslint-disable-next-line no-new-func -- the script as the browser runs it
    new Function(FIRST_PAINT_SCRIPT)();
    expect(rail()).toMatchObject({ lang: 'de', label: 'Hauptnavigation', checked: true, text: 'E-Mail' });
  } finally {
    localStorage.clear();
  }
  expect(FIRST_PAINT_SCRIPT.length).toBeLessThan(4096);
});

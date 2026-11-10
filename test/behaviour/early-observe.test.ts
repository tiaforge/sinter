// Prototype `firstPaint: 'observe'`: the early file runs from the head and renders each root as the
// parser closes it (MutationObserver), skipping messages whose dictionary is still on its way.
import { afterEach, expect, test } from 'vitest';
import { byId, cls, iff, observe, text, w, type EarlyPage } from '../../src/early.js';
import { meeting } from '../../src/runtime/handoff.js';

const I18N = Symbol.for('sinter.i18n');
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** a document still being parsed: `readyState` reads `loading` until `end()` */
function parsing() {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  let state: DocumentReadyState = 'loading';
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => state });
  const end = () => { if (state != 'loading') return; state = 'interactive'; document.dispatchEvent(new Event('DOMContentLoaded')); };
  ends.push(end);
  return { end };
}

let ends: Array<() => void> = [];
afterEach(() => {
  // a test that failed mid-parse must not leave its observer to the next one
  for (const e of ends) e();
  ends = [];
  delete (document as any).readyState;
  delete (globalThis as any)[Symbol.for('sinter.early.page')];
  delete (globalThis as any)[I18N];
});

/** roots 1 (text), 2 (if) and 3 (its else); `msg`: root 1's text reads the dictionary. One function table, as compiled pages have */
const hi = () => (globalThis as any)[I18N].dicts[(globalThis as any)[I18N].locale].hi, early = () => 'early', no = () => false;
const page = (msg = false): EarlyPage => () => ({
  ir: {}, fns: [],
  scopes: () => [],
  render(d) {
    const n = byId(d, [1, 2, 3]);
    w(n[0]!, msg ? hi : early, null, text);
    w(n[1]!, no, null, (t, v) => iff(t as HTMLTemplateElement, v, n[2] as HTMLTemplateElement | null, 0, 0, null));
  },
});

test('each root is rendered once the parser has moved past it, before DOMContentLoaded', async () => {
  const doc = parsing();
  observe(page());
  const p = document.createElement('p');
  p.setAttribute('data-sn', '1');
  document.body.append(p);
  await tick();
  // still open: its content may not be parsed yet
  expect(p.textContent).toBe('');
  document.body.append(document.createTextNode('\n'));
  await tick();
  expect(p.textContent).toBe('early');
  // the if and its else: rendered once the else is parsed too
  document.body.insertAdjacentHTML('beforeend', '<template data-sn="2"><b>yes</b></template><template data-sn="3" data-sn-else><i>no</i></template>');
  await tick();
  expect(document.body.querySelector('i')).toBeNull();
  document.body.append(document.createElement('footer'));
  await tick();
  expect(document.body.querySelectorAll('i').length).toBe(1);
  let done = false;
  void meeting().done.then(() => { done = true; });
  await tick();
  expect(done).toBe(false);
  doc.end();
  await tick();
  expect(done).toBe(true);
  // the last pass renders nothing twice
  expect(document.body.querySelectorAll('i').length).toBe(1);
  expect(p.textContent).toBe('early');
});

test('a message waits for its dictionary without holding anything, and is rendered if it arrives during the parse', async () => {
  const doc = parsing();
  const g = ((globalThis as any)[I18N] = { locale: 'de', base: 'en', dicts: {} as Record<string, any> });
  observe(page(true), { use() {}, state: () => g });
  document.body.innerHTML = '<p data-sn="1"></p>\n';
  await tick();
  expect(document.querySelector('p')!.textContent).toBe('');
  // the language file arrives
  g.dicts.de = { hi: 'Hallo' };
  (g as any).loaded('de');
  expect(document.querySelector('p')!.textContent).toBe('Hallo');
  doc.end();
});

test('a dictionary arriving after the parse is left to the page module', async () => {
  const doc = parsing();
  const g = ((globalThis as any)[I18N] = { locale: 'de', base: 'en', dicts: {} as Record<string, any> });
  observe(page(true), { use() {}, state: () => g });
  document.body.innerHTML = '<p data-sn="1"></p>\n';
  doc.end();
  await tick();
  expect(g.dicts.de).toBeUndefined();
  g.dicts.de = { hi: 'Hallo' };
  (g as any).loaded?.('de');
  expect(document.querySelector('p')!.textContent).toBe('');
});

const yes = () => true, txt = () => 'text';
test('an element\'s own attributes are written when the parser inserts it; its content once it has closed it', async () => {
  const doc = parsing();
  // root 1: a class (attribute-like) and its text (content), as on a wrapper that holds the rest of the page
  observe(() => ({
    ir: {}, fns: [], scopes: () => [],
    render(d) { const n = byId(d, [1]); w(n[0]!, yes, null, cls, 'collapsed'); w(n[0]!, txt, null, text); },
  }));
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-sn', '1');
  document.body.append(wrapper);
  await tick();
  // still open (the rest of the page is still to come): the class is there, the content waits
  expect(wrapper.classList.contains('collapsed')).toBe(true);
  expect(wrapper.textContent).toBe('');
  document.body.append(document.createElement('footer'));
  await tick();
  expect(wrapper.textContent).toBe('text');
  doc.end();
});

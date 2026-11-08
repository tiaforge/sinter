// The render-blocking fallback (src/paint-build.ts): where `blocking="render"` is not supported
// (Firefox), the page's first classic script hides <html> and turns transitions off until the early
// file has rendered and the stylesheets have applied. Run in jsdom, which has no `blocking` either.
// @ts-expect-error: jsdom (a dev dependency) has no type declarations here
import { JSDOM } from 'jsdom';
import { expect, test } from 'vitest';
import { I18N_PICKER } from '../../src/i18n-build.js';
import { PAINT_SCRIPT } from '../../src/paint-build.js';

const K = Symbol.for('sinter.early.page');
interface Meeting { started: boolean; done: Promise<void>; finish(): void }

/** a page whose head runs `script` inline, as the build's external tag would; `blocking`: the browser supports it */
function page(script: string, o: { early?: boolean; blocking?: boolean; head?: string; meeting?: boolean } = {}) {
  const sheets: unknown[][] = [], loads: Array<() => void> = [];
  const dom = new JSDOM(`<!doctype html><html><head><script${o.early === false ? '' : ' data-sn-early'}>${script}</script>${o.head ?? ''}</head><body><nav>x</nav></body></html>`, {
    runScripts: 'dangerously',
    beforeParse(w: any) {
      if (o.blocking) Object.defineProperty(w.HTMLScriptElement.prototype, 'blocking', { value: '' });
      let adopted: unknown[] = [];
      Object.defineProperty(w.Document.prototype, 'adoptedStyleSheets', { get: () => adopted, set: (v) => { adopted = v; sheets.push(v); }, configurable: true });
      (w as any).matchMedia = (q: string) => ({ matches: q !== 'print' });
      // jsdom fires the window's load right after the parse: the test fires it
      const add = w.addEventListener.bind(w);
      w.addEventListener = ((type: string, f: () => void, ...a: never[]) => { if (type == 'load') loads.push(f); else add(type, f, ...a); }) as never;
      if (o.meeting) { let f!: () => void; (w as any)[K] = { started: true, done: new Promise<void>((r) => { f = r; }), finish: () => f() }; }
    },
  });
  const w = dom.window, html = w.document.documentElement;
  return {
    w, sheets, load: () => loads.forEach((f) => f()),
    meeting: () => (w as any)[K] as Meeting | undefined,
    hidden: () => html.style.visibility == 'hidden',
    transitionsOff: () => (w.document as any).adoptedStyleSheets.length > 0,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

for (const [name, script] of [['the paint script', PAINT_SCRIPT], ['the language picker', I18N_PICKER]] as const) {
  test(`${name}: without \`blocking\`, <html> is hidden and transitions are off until the early file has rendered`, async () => {
    const p = page(script);
    expect(p.hidden()).toBe(true);
    expect(p.transitionsOff()).toBe(true);
    // the global the early file and the page module meet at, created as runtime/handoff.ts does
    const m = p.meeting()!;
    expect(m.started).toBe(false);
    expect(m.done).toBeInstanceOf(p.w.Promise);
    await tick();
    expect(p.hidden()).toBe(true);
    m.finish();
    await tick();
    expect(p.hidden()).toBe(false);
    expect(p.transitionsOff()).toBe(false);
    p.w.close();
  });
}

test('with `blocking` (Chromium), or on a page without an early file, nothing changes', () => {
  for (const p of [page(PAINT_SCRIPT, { blocking: true }), page(I18N_PICKER, { blocking: true }), page(I18N_PICKER, { early: false })]) {
    expect(p.hidden()).toBe(false);
    expect(p.sheets).toEqual([]);
    expect(p.meeting()).toBeUndefined();
    p.w.close();
  }
});

test('it waits for the stylesheets to apply (not for print sheets)', async () => {
  const p = page(PAINT_SCRIPT, { head: '<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/p.css" media="print">' });
  p.meeting()!.finish();
  await tick();
  expect(p.hidden()).toBe(true);
  // jsdom loads no stylesheet: the load event stands for it
  p.w.document.querySelector('link')!.dispatchEvent(new p.w.Event('load'));
  await tick();
  expect(p.hidden()).toBe(false);
  expect(p.transitionsOff()).toBe(false);
  p.w.close();
});

test('the early file came first: its global is used', async () => {
  const p = page(PAINT_SCRIPT, { meeting: true });
  expect(p.meeting()!.started).toBe(true);
  expect(p.hidden()).toBe(true);
  p.meeting()!.finish();
  await tick();
  expect(p.hidden()).toBe(false);
  p.w.close();
});

test('an early file that never renders: the window\'s load ends it', async () => {
  const p = page(PAINT_SCRIPT);
  p.load();
  expect(p.hidden()).toBe(false);
  expect(p.transitionsOff()).toBe(false);
  p.w.close();
});

test('a stylesheet that never loads: <html> shows after 2 s, transitions stay off until the window\'s load', async () => {
  const p = page(PAINT_SCRIPT, { head: '<link rel="stylesheet" href="/slow.css">' });
  p.meeting()!.finish();
  await new Promise((r) => setTimeout(r, 2050));
  expect(p.hidden()).toBe(false);
  expect(p.transitionsOff()).toBe(true);
  p.load();
  expect(p.transitionsOff()).toBe(false);
  p.w.close();
}, 5000);

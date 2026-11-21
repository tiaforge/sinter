// The space a list in a kept element holds while its rows load (docs/first-paint.md#reserved-space), across a
// swap (docs/proposals/swap-navigation.md §3): its placeholder is numbered in the kept element's range, so the
// next page's code finds it in the element the swap keeps, and the next page's own node of the page-numbered
// id it once had is that page's.
import { afterEach, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { compactIR } from '../../src/ir.js';
import { instance, mount } from '../../src/runtime/app.js';
import { defaultEnv } from '../../src/runtime/env.js';
import { handOver } from '../../src/swap-run.js';
import back from '../../src/back.js';
import paginate from '../../src/paginate.js';

afterEach(() => { try { instance(document).destroy(); } catch { /* none */ } });

const CSS = 'ul { margin: 0; padding: 0 } li { height: 20px }';
const KEPT = '<aside data-sn-permanent="side"><ul><template data-sn-for="p in people"><li data-sn-text="p.name"></li></template></ul></aside>';
const RES = '<sn-resource name="people" src="/api/people" select="people" key="id" paginate="{ numbered: true, size: 3 }"></sn-resource>';
const source = (before: string) => `<html><head></head><body>${RES}${before}${KEPT}</body></html>`;
const compiled = (before: string, file = '/p/x.html') => compileParts(source(before), {
  file, root: '/p', dev: false, swap: true, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  styles: [{ file: 'test.css', css: CSS }], paintCss: 'paint.css',
});
const page = (before: string, file?: string) => {
  const parts = compiled(before, file);
  const fns = new Function('$k', `return [${parts.fns.join(',')}]`)((x: unknown) => x);
  const known = { paginate, back } as Record<string, typeof paginate>;
  return { ir: compactIR(parts.ir), fns, features: parts.features.map((f) => known[f]!), html: /<body>([\s\S]*)<\/body>/i.exec(parts.html)![1]!, paint: parts.paint };
};
const held = () => document.querySelector('aside .sn-reserve');

test('the placeholder in a kept element: the same id and class on every page that keeps it, in the element\'s range', () => {
  const a = page('', '/p/a.html'), b = page('<p data-sn-state="{ n: 1 }"><b data-sn-text="n"></b><i data-sn-text="n + 1"></i></p>', '/p/b.html');
  const ph = (h: string) => { const d = document.createElement('div'); d.innerHTML = h; return d.querySelector('.sn-reserve')!; };
  expect(ph(a.html).getAttribute('data-sn')).toBe(ph(b.html).getAttribute('data-sn'));
  expect(Number(ph(a.html).getAttribute('data-sn'))).toBeGreaterThanOrEqual(1_000_000);
  expect(ph(a.html).className).toBe(ph(b.html).className);
  expect(b.paint).toContain(`.${ph(a.html).className.split(' ')[1]}:not(#_)`);
});

test('a swap while the kept list loads: the next page\'s own nodes are its, the placeholder goes once its rows are there', async () => {
  let answer: ((r: Response) => void) | undefined;
  const env = { ...defaultEnv, href: () => 'http://localhost/', fetch: () => new Promise<Response>((r) => { answer = r; }) };
  const a = page('', '/p/a.html');
  document.body.innerHTML = a.html;
  mount(document, { ...a, env });
  await Promise.resolve();
  expect(held()).not.toBeNull();
  // the next page: bound nodes before the kept element, numbered from 1 as the first page's placeholder was
  const b = page('<p data-sn-state="{ n: 1 }"><button data-sn-on-click="n++">+</button><b data-sn-text="n"></b></p>', '/p/b.html');
  const old = instance(document), kept = document.querySelector('aside')!;
  handOver(old.rbs, [kept]);
  old.destroy();
  const next = document.createElement('div');
  next.innerHTML = b.html;
  kept.before(...[...next.childNodes].filter((n) => !(n as Element).matches?.('aside')));
  mount(document, { ...b, env });
  await Promise.resolve();
  expect(document.querySelector('b')!.textContent).toBe('1');
  document.querySelector('button')!.click();
  await Promise.resolve();
  expect(document.querySelector('b')!.textContent).toBe('2');
  expect(held()).not.toBeNull();
  answer!(new Response(JSON.stringify({ people: [{ id: 1, name: 'P1' }] }), { headers: { 'content-type': 'application/json' } }));
  for (let i = 0; i < 20 && held(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(held()).toBeNull();
  expect([...document.querySelectorAll('aside li')].map((l) => l.textContent)).toEqual(['P1']);
});

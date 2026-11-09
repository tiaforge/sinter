// `data-sn-transition`: the followed row's element and the next page's element of the same name
// get one view-transition-name, only for the transition.
import { expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/compile.js';
import { ident } from '../../src/transition.js';
import { memoryStorage, mockRequests, render, type Rendered } from '../../src/testing/index.js';

const LIST = `
  <sn-resource name="articles" src="/api/articles" items="articles" key="slug"></sn-resource>
  <ul><template data-sn-for="a in articles"><li>
    <img alt="" data-sn-transition="'article-' + a.slug">
    <a data-sn-attr="{href: '/article/' + a.slug}" data-sn-text="a.title"></a>
  </li></template></ul>
  <a id="plain" href="/about">about</a>`;
const DETAIL = `<html data-sn-path="/article/:slug"><head></head><body>
  <sn-resource name="article" src="/api/articles/{$url.slug}" items="article"></sn-resource>
  <h1 data-sn-transition="'article-' + $url.slug" data-sn-text="article?.title"></h1>
</body></html>`;

/** a view transition the test settles by hand */
function transition() {
  let done!: () => void;
  return { vt: { finished: new Promise<void>((r) => { done = r; }) }, done: async () => { done(); await Promise.resolve(); await Promise.resolve(); } };
}
const fire = (r: Rendered, type: 'pageswap' | 'pagereveal', props: Record<string, unknown>) => r.window(type, props);

test('the followed row\'s element and the next page\'s element of the same name morph; the names go after', async () => {
  const session = memoryStorage();
  const r = await render(LIST, { session, requests: mockRequests({ 'GET /api/articles': { articles: [{ slug: 'one', title: 'One' }, { slug: 'two', title: 'Two' }] } }) });
  await r.settle();
  const imgs = [...r.root.querySelectorAll('img')];
  r.root.querySelectorAll('a')[1]!.click();
  const out = transition();
  await fire(r, 'pageswap', { viewTransition: out.vt, activation: { entry: { url: 'http://localhost/article/two' }, navigationType: 'push' } });
  expect(imgs.map((i) => i.style.viewTransitionName)).toEqual(['', ident('article-two')]);
  expect(imgs[1]!.style.getPropertyValue('view-transition-class')).toBe('sn-transition');
  await out.done();
  expect(imgs[1]!.style.viewTransitionName).toBe('');
  expect(imgs[1]!.style.getPropertyValue('view-transition-class')).toBe('');

  const page = await render(DETAIL, { session, url: '/article/two', requests: mockRequests({ 'GET /api/articles/two': { article: { title: 'Two' } } }) });
  await page.settle();
  const inn = transition();
  await fire(page, 'pagereveal', { viewTransition: inn.vt });
  expect(page.root.querySelector('h1')!.style.viewTransitionName).toBe(ident('article-two'));
  await inn.done();
  expect(page.root.querySelector('h1')!.style.viewTransitionName).toBe('');
});

test('a link to elsewhere, or a navigation the click did not start, names nothing; back names a detail page\'s one element', async () => {
  const session = memoryStorage();
  const r = await render(LIST, { session, requests: mockRequests({ 'GET /api/articles': { articles: [{ slug: 'one', title: 'One' }] } }) });
  await r.settle();
  r.root.querySelector<HTMLAnchorElement>('#plain')!.click();
  await fire(r, 'pageswap', { viewTransition: transition().vt, activation: { entry: { url: 'http://localhost/about' }, navigationType: 'push' } });
  expect(r.root.querySelector('img')!.style.viewTransitionName).toBe('');
  expect(session.getItem('sn:vt')).toBeNull();

  const page = await render(DETAIL, { session, url: '/article/one', requests: mockRequests({ 'GET /api/articles/one': { article: { title: 'One' } } }) });
  await page.settle();
  await fire(page, 'pageswap', { viewTransition: transition().vt, activation: { entry: { url: 'http://localhost/' }, navigationType: 'traverse' } });
  expect(page.root.querySelector('h1')!.style.viewTransitionName).toBe(ident('article-one'));
  expect(session.getItem('sn:vt')).toBe('article-one');
});

test('the compiler adds the transition feature only to pages that use the attribute, and checks the expression', () => {
  const opts = { file: '/t/p.html', root: '/t', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } };
  expect(compileParts(DETAIL, opts).features).toContain('transition');
  expect(compileParts('<p data-sn-text="1"></p>', opts).features).not.toContain('transition');
  const bad = compileParts(`<div data-sn-state="{ id: 1 }"><p data-sn-transition="'x-' + idd"></p></div>`, opts);
  expect(bad.diagnostics.map((d) => d.code)).toContain('SN201');
});

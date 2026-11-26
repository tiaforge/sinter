// `data-sn-transition`: the followed row's element and the next page's element of the same name
// get one view-transition-name, only for the transition.
import { expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/compile.js';
import { ident } from '../../src/transition.js';
import { REVEAL_MAX, morphHeld } from '../../src/swap-run.js';
import { memoryStorage, mockRequests, render, type Rendered } from '../../src/testing/index.js';

const LIST = `
  <sn-resource name="articles" src="/api/articles" select="articles" key="slug"></sn-resource>
  <ul><template data-sn-for="a in articles"><li>
    <img alt="" data-sn-transition="'article-' + a.slug">
    <a data-sn-attr="{href: '/article/' + a.slug}" data-sn-text="a.title"></a>
  </li></template></ul>
  <a id="plain" href="/about">about</a>`;
const DETAIL = `<html data-sn-path="/article/:slug"><head></head><body>
  <sn-resource name="article" src="/api/articles/{$url.slug}" select="article"></sn-resource>
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
  expect(JSON.parse(session.getItem('sn:vt')!).v).toBe('article-one');
});

test('the compiler adds the transition feature only to pages that use the attribute, and checks the expression', () => {
  const opts = { file: '/t/p.html', root: '/t', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } };
  expect(compileParts(DETAIL, opts).features).toContain('transition');
  expect(compileParts('<p data-sn-text="1"></p>', opts).features).not.toContain('transition');
  const bad = compileParts(`<div data-sn-state="{ id: 1 }"><p data-sn-transition="'x-' + idd"></p></div>`, opts);
  expect(bad.diagnostics.map((d) => d.code)).toContain('SN201');
});

test('a pending name older than PENDING_MAX is ignored (a page without the feature never took it)', async () => {
  const session = memoryStorage();
  session.setItem('sn:vt', JSON.stringify({ v: 'article-two', t: Date.parse('2026-01-01T08:59:00Z') }));
  const page = await render(DETAIL, { session, url: '/article/two', requests: mockRequests({ 'GET /api/articles/two': { article: { title: 'Two' } } }) });
  await page.settle();
  await fire(page, 'pagereveal', { viewTransition: transition().vt });
  expect(page.root.querySelector('h1')!.style.viewTransitionName).toBe('');
  expect(session.getItem('sn:vt')).toBeNull();
});

test('with reduced motion asked for, nothing is named on either page and no pending name is kept', async () => {
  const session = memoryStorage();
  const r = await render(LIST, { session, reducedMotion: true, requests: mockRequests({ 'GET /api/articles': { articles: [{ slug: 'one', title: 'One' }] } }) });
  await r.settle();
  r.root.querySelectorAll('a')[0]!.click();
  await fire(r, 'pageswap', { viewTransition: transition().vt, activation: { entry: { url: 'http://localhost/article/one' }, navigationType: 'push' } });
  expect(r.root.querySelector('img')!.style.viewTransitionName).toBe('');
  expect(session.getItem('sn:vt')).toBeNull();

  // a name left by a page that allowed motion: taken, not used
  session.setItem('sn:vt', JSON.stringify({ v: 'article-one', t: Date.parse('2026-01-01T09:00:00Z') }));
  const page = await render(DETAIL, { session, reducedMotion: true, url: '/article/one', requests: mockRequests({ 'GET /api/articles/one': { article: { title: 'One' } } }) });
  await page.settle();
  await fire(page, 'pagereveal', { viewTransition: transition().vt });
  expect(page.root.querySelector('h1')!.style.viewTransitionName).toBe('');
  expect(session.getItem('sn:vt')).toBeNull();
});

// the detail page's element renders only from its response (an article's title inside its `if`)
const GATED = `<html data-sn-path="/article/:slug"><head></head><body>
  <sn-resource name="article" src="/api/articles/{$url.slug}" select="article"></sn-resource>
  <template data-sn-if="article"><h1 data-sn-transition="'article-' + $url.slug" data-sn-text="article.title"></h1></template>
</body></html>`;

test('a swap holds its reveal until the element of the pending morph renders from the page\'s first response', async () => {
  const session = memoryStorage();
  session.setItem('sn:vt', JSON.stringify({ v: 'article-two', t: Date.parse('2026-01-01T09:00:00Z') }));
  const page = await render(GATED, { session, url: '/article/two', requests: mockRequests({ 'GET /api/articles/two': { article: { title: 'Two' } } }) });
  expect(page.root.querySelector('h1')).toBeNull();
  const hooks = page.app.afterFlush.length, held = morphHeld(page.app)!;
  expect(held).toBeInstanceOf(Promise);
  let done = false;
  void held.then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  await page.settle();
  await held;
  // then the reveal names it, as at mount
  const inn = transition();
  await fire(page, 'pagereveal', { viewTransition: inn.vt });
  expect(page.root.querySelector('h1')!.style.viewTransitionName).toBe(ident('article-two'));
  expect(page.app.afterFlush.length).toBe(hooks);
});

test('a swap holds its reveal REVEAL_MAX at most, and not at all with the element there, no requests out or no morph pending', async () => {
  const session = memoryStorage(), pending = () => session.setItem('sn:vt', JSON.stringify({ v: 'article-two', t: Date.parse('2026-01-01T09:00:00Z') }));
  const routes = () => mockRequests({ 'GET /api/articles/two': { article: { title: 'Two' } } });
  pending();
  const slow = await render(GATED, { session, url: '/article/two', requests: routes() });
  const hooks = slow.app.afterFlush.length, held = morphHeld(slow.app)!;
  await slow.advance(REVEAL_MAX);
  await held;
  expect(slow.root.querySelector('h1')).toBeNull();
  expect(slow.app.afterFlush.length).toBe(hooks);

  const ready = await render(DETAIL, { session, url: '/article/two', requests: routes() });
  expect(morphHeld(ready.app)).toBeUndefined();
  const settled = await render(GATED, { session, url: '/article/three', requests: mockRequests({ 'GET /api/articles/three': { status: 404 } }) });
  await settled.settle();
  expect(morphHeld(settled.app)).toBeUndefined();
  session.removeItem('sn:vt');
  const none = await render(GATED, { session, url: '/article/two', requests: routes() });
  expect(morphHeld(none.app)).toBeUndefined();
  expect(morphHeld(undefined)).toBeUndefined();
});

test('a transition aborted while it runs (the page navigates away) leaves no unhandled rejection', async () => {
  // Chromium rejects ready and updateCallbackDone of an aborted transition, and reports them as unhandled once a
  // script holds the transition (sinter-alloy's CI: "Transition was aborted because of invalid state")
  const unhandled: unknown[] = [];
  const on = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', on);
  try {
    const r = await render(LIST, { session: memoryStorage(), requests: mockRequests({ 'GET /api/articles': { articles: [{ slug: 'one', title: 'One' }] } }) });
    await r.settle();
    r.root.querySelectorAll('a')[0]!.click();
    const aborted = () => Promise.reject(new DOMException('Transition was aborted because of invalid state', 'InvalidStateError'));
    await fire(r, 'pageswap', { viewTransition: { finished: Promise.resolve(), ready: aborted(), updateCallbackDone: aborted() }, activation: { entry: { url: 'http://localhost/article/one' }, navigationType: 'push' } });
    await new Promise((res) => setTimeout(res, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', on);
  }
});

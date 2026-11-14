// The space a list holds before its data arrives (docs/first-paint.md#reserved-space): the build
// writes a placeholder after the template, and the page module removes it once the resource has rows,
// has loaded (empty too) or has failed. Its size is the build's (test/compiler/reserve.test.ts).
import { expect, test } from 'vitest';
import { memoryStorage, mockRequests, render } from '../../src/testing/index.js';
import { compile } from '../../src/compiler/index.js';

const CSS = 'ul { margin: 0; padding: 0 } li { height: 20px }';
const PAGE = (attrs = '', resource = 'paginate="offset" page-size="3"') => `
  <sn-resource name="people" src="/api/people" items="people" key="id" ${resource}></sn-resource>
  <ul><template data-sn-for="p in people"${attrs}><li data-sn-text="p.name"></li></template></ul>`;
const rows = (n: number) => ({ people: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}` })) });
const held = (root: ParentNode) => root.querySelector('ul > .sn-reserve');

test('the placeholder stands after the template until the rows arrive, then the rows are the list\'s only children', async () => {
  const requests = mockRequests({ 'GET /api/people?page=1&limit=3': rows(3) });
  const { root, settle } = await render(PAGE(), { requests, css: CSS });
  expect(held(root)).not.toBeNull();
  expect(held(root)!.getAttribute('aria-hidden')).toBe('true');
  expect(held(root)!.previousElementSibling!.localName).toBe('template');
  await settle();
  expect(held(root)).toBeNull();
  expect([...root.querySelectorAll('ul > li')].map((l) => l.textContent)).toEqual(['P1', 'P2', 'P3']);
});

test('an empty list and a failed load remove it too', async () => {
  for (const answer of [rows(0), { status: 500 }]) {
    const { root, settle } = await render(PAGE(), { requests: mockRequests({ 'GET /api/people?page=1&limit=3': answer }), css: CSS });
    expect(held(root)).not.toBeNull();
    await settle();
    expect(held(root)).toBeNull();
  }
});

test('a list whose `src` cannot be built loads nothing: removed at mount', async () => {
  const { root } = await render(PAGE('', 'paginate="offset" page-size="3"').replace('src="/api/people"', 'src="/api/people/{boom()}"'), { requests: mockRequests({}), css: CSS, helpers: { boom: () => { throw new Error('no'); } } });
  expect(held(root)).toBeNull();
});

test('cached rows replace it when the page module mounts', async () => {
  // the previous page loaded them
  const session = memoryStorage(), page = PAGE('', 'paginate="offset" page-size="3" cache');
  await (await render(page, { requests: mockRequests({ 'GET /api/people?page=1&limit=3': rows(2) }), css: CSS, session })).settle();
  const { root } = await render(PAGE('', 'paginate="offset" page-size="3" cache'), { requests: mockRequests({ 'GET /api/people?page=1&limit=3': rows(2) }), css: CSS, session });
  expect(held(root)).toBeNull();
  expect(root.querySelectorAll('ul > li').length).toBe(2);
});

test('not for a list without pages: the build cannot count its rows', async () => {
  const { root } = await render(PAGE('', ''), { requests: mockRequests({ 'GET /api/people': rows(4) }), css: CSS });
  expect(held(root)).toBeNull();
});

test('not for a list the build cannot count (a filter), nor one the page embeds', async () => {
  for (const page of [
    PAGE().replace('p in people', 'p in people.filter((x) => x.id > 1)'),
    `<script type="application/json" data-sn-data="people">{"people":[]}</script>${PAGE()}`,
  ]) {
    const { root } = await render(page, { requests: mockRequests({ 'GET /api/people?page=1&limit=3': rows(1) }), css: CSS });
    expect(held(root)).toBeNull();
  }
});

test('a resource with `when`: held while it loads, as a branch the early file decides', async () => {
  const page = PAGE('', 'paginate="offset" page-size="3" when="$url.go"');
  const on = await render(page, { url: 'http://localhost/?go=1', requests: mockRequests({ 'GET /api/people?page=1&limit=3': rows(3) }), css: CSS });
  expect(held(on.root)).not.toBeNull();
  await on.settle();
  expect(held(on.root)).toBeNull();
  expect(on.root.querySelectorAll('ul > li').length).toBe(3);
  const off = await render(page, { requests: mockRequests({}), css: CSS });
  expect(held(off.root)).toBeNull();
});

test('a list chosen by the URL (a data-sn-let over two resources): held for the one that loads', async () => {
  const page = `<sn-resource name="mine" src="/api/mine" items="people" key="id" paginate="offset" page-size="3" when="$url.feed"></sn-resource>
    <sn-resource name="all" src="/api/all" items="people" key="id" paginate="offset" page-size="3" when="!$url.feed"></sn-resource>
    <ul data-sn-let="{ list: $url.feed ? mine : all }"><template data-sn-for="p in list"><li data-sn-text="p.name"></li></template></ul>`;
  const { root, settle } = await render(page, { requests: mockRequests({ 'GET /api/all?page=1&limit=3': rows(2) }), css: CSS });
  expect(held(root)).not.toBeNull();
  await settle();
  expect(held(root)).toBeNull();
  expect(root.querySelectorAll('ul > li').length).toBe(2);
});

test('a "Loading…" branch right before the list takes the placeholder\'s place; another one beside it leaves none', () => {
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: CSS + ' .ld { margin: 4px 0 }' }], paintCss: '/p.css' };
  const list = '<sn-resource name="people" src="/api/people" items="people" key="id" paginate="offset" page-size="3"></sn-resource>';
  const loading = '<template data-sn-if="$meta.people.loading && !people.length"><p class="ld">Loading…</p></template>';
  const tpl = '<template data-sn-for="p in people"><li data-sn-text="p.name"></li></template>';
  const out = compile(`<!doctype html><html><head></head><body>${list}<ul>${loading}${tpl}</ul></body></html>`, opts);
  expect(out.html).toMatch(/<p class="ld snr\w+0b">Loading…<\/p>/);
  expect(out.paint).toMatch(/\.snr\w+0b ~ \.sn-reserve\.snr\w+0:not\(#_\) \{ display:none !important \}/);
  expect(out.paint).toMatch(/\.snr\w+0b:not\(#_\) \{ box-sizing:border-box !important;min-height:60px !important;margin-top:0px !important;margin-bottom:0px !important \}/);
  // after the list: it would show with the placeholder
  const after = compile(`<!doctype html><html><head></head><body>${list}<ul>${tpl}${loading}</ul></body></html>`, opts);
  expect(after.html).not.toContain('sn-reserve');
  // an empty state or an error over the same status never shows with the placeholder
  const empty = compile(`<!doctype html><html><head></head><body>${list}<ul>${tpl}<template data-sn-if="!$meta.people.loading && !people.length"><p>None</p></template></ul></body></html>`, opts);
  expect(empty.html).toContain('sn-reserve');
});

test('the build: the placeholder\'s rule in the page\'s first-paint stylesheet, imported by the page module', () => {
  const out = compile(`<!doctype html><html><head></head><body>${PAGE()}</body></html>`, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} },
    prerender: true, styles: [{ file: 'a.css', css: CSS }], paintCss: '/@sinter/paint-css/index.html.css',
  });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toMatch(/<\/template><li class="sn-reserve snr[a-z0-9]+0" aria-hidden="true" data-sn="\d+"><\/li><\/ul>/);
  // one base rule per page, then each list's own height
  expect(out.paint).toMatch(/^\.sn-reserve:not\(#_\) \{ display:block !important;[^}]*\}\n\.sn-reserve\.snr[a-z0-9]+0:not\(#_\) \{ height:60px !important \}\n$/);
  expect(out.module).toContain('import "/@sinter/paint-css/index.html.css";');
  // no rules: nothing imported
  const none = compile('<!doctype html><html><head></head><body><p>x</p></body></html>', { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: CSS }], paintCss: '/p.css' });
  expect(none.paint).toBe('');
  expect(none.module).not.toContain('/p.css');
});

test('what follows a box whose width follows its content stays hidden while the list\'s first rows load (builds)', () => {
  const css = '.row { display: flex; flex-wrap: wrap }';
  const page = (box = '') => `<sn-resource name="people" src="/api/people" items="people" key="id"></sn-resource>
    <div class="row"><div class="feed"${box}><template data-sn-for="p in people"><p class="card" data-sn-text="p.name"></p></template></div><aside>tags</aside></div>`;
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css }], paintCss: '/p.css' };
  const out = compile(page(), opts);
  // instead of SN529: the build names the box
  expect(out.diagnostics.filter((d) => d.code === 'SN529')).toEqual([]);
  expect(out.waits).toEqual([expect.objectContaining({ what: 'div.feed', widths: 'at every width', line: 2 })]);
  // the box gets a class, a hidden marker follows the template; the page module removes the marker for good once the
  // resource has rows or no load is running
  const k = /<div class="feed (snw[a-z0-9]+)">/.exec(out.html)![1]!;
  expect(out.html).toMatch(new RegExp(`</template><i class="${k}m" hidden="" data-sn="\\d+"></i></div><aside>`));
  expect(out.module).toMatch(/\$\.\$r\.people\?\.length \|\| !\$\.\$meta\.people\.loading\) && \$\.\$el\.remove\(\)/);
  // its siblings after it are invisible (laid out, not shown) while the marker is there, for at most 3 s
  expect(out.paint).toContain('@keyframes sn-wait { to { visibility: visible } }');
  expect(out.paint).toContain(`.${k}:has(.${k}m) ~ :not(#_) { visibility: hidden; animation: sn-wait 0s 3s forwards }`);
  // dev plans the same: no SN529, nothing added
  const dev = compile(page(), { ...opts, paintCss: undefined });
  expect(dev.diagnostics.filter((d) => d.code === 'SN529')).toEqual([]);
  expect(dev.html).not.toContain('snw');
  // a box with a width of its own: nothing moves, nothing is hidden
  const sized = compile(page(), { ...opts, styles: [{ file: 'a.css', css: css + ' .feed { flex: 1 1 0 }' }] });
  expect(sized.waits).toBeUndefined();
  expect(sized.html).not.toContain('snw');
});

test('what follows the box is hidden only at the widths where its width follows its content', () => {
  // a grid system: below 768 px the column is a flex item with no basis, from 768 px it has one
  const css = '.row { display: flex; flex-wrap: wrap } @media (min-width: 768px) { .col-9 { flex: 0 0 75%; max-width: 75% } }';
  const out = compile(`<sn-resource name="people" src="/api/people" items="people" key="id"></sn-resource>
    <div class="row"><div class="col-9"><template data-sn-for="p in people"><p data-sn-text="p.name"></p></template></div><div class="col-3">tags</div></div>`, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css }], paintCss: '/p.css',
  });
  expect(out.waits?.[0]?.widths).toBe('below 768 px');
  expect(out.paint).toMatch(/@media \(max-width: 767\.98px\) \{ \.snw[a-z0-9]+:has\(\.snw[a-z0-9]+m\) ~ :not\(#_\) \{ visibility: hidden;/);
});

test('a choice between resources: the marker shows on the first load of those the early file knows', () => {
  // "Your Feed" waits for the user (its `when` reads another resource): the early file cannot tell whether it loads at
  // mount, so it never shows the marker; the articles' first load does
  const css = '.row { display: flex; flex-wrap: wrap }';
  const out = compile(`<sn-resource name="user" src="/api/user"></sn-resource>
    <sn-resource name="articles" src="/api/articles" items="articles" when="$url.feed != 'mine'"></sn-resource>
    <sn-resource name="feed" src="/api/feed" items="articles" when="$url.feed == 'mine' && user"></sn-resource>
    <div class="row"><div class="feed" data-sn-let="{ list: $url.feed == 'mine' ? feed : articles }"><template data-sn-for="a in list"><p data-sn-text="a.title"></p></template></div><aside>tags</aside></div>`, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css }], paintCss: '/p.css',
  });
  expect(out.waits).toHaveLength(1);
  expect(out.module).toContain('$.$meta.articles.loading && !$.$meta.articles.loadedAt');
  expect(out.module).not.toContain('$.$meta.feed.loading && !$.$meta.feed.loadedAt');
});

test('SN529: a list over late data in a flex item whose width follows its content', async () => {
  const css = '.row { display: flex; flex-wrap: wrap }';
  // `data-sn-wait="off"`: what follows the box is not hidden while the rows load, and the build says why it moves
  const page = (resource = '') => `<sn-resource name="people" src="/api/people" items="people" key="id" ${resource}></sn-resource>
    <div class="row"><div class="feed" data-sn-wait="off"><template data-sn-for="p in people"><p class="card" data-sn-text="p.name"></p></template></div><aside>tags</aside></div>`;
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css }], paintCss: '/p.css' };
  const off = compile(page(), opts);
  const warned = off.diagnostics.filter((d) => d.code === 'SN529');
  expect(warned).toHaveLength(1);
  expect(off.diagnostics.filter((d) => d.code === 'SN101')).toEqual([]);
  expect(off.html).not.toContain('data-sn-wait');
  expect(off.html).not.toContain('snw');
  expect(warned[0]!.message).toContain('`<div.feed>`');
  // with a basis of its own, nothing to say
  expect(compile(page(), { ...opts, styles: [{ file: 'a.css', css: css + ' .feed { flex: 1 1 0 }' }] }).diagnostics.filter((d) => d.code === 'SN529')).toEqual([]);
  // rows of a width of their own, paginated: a placeholder as wide holds the box's width, nothing to say either
  const fixed = compile(page('paginate="offset" page-size="4"'), { ...opts, styles: [{ file: 'a.css', css: css + ' .card { width: 280px; height: 40px; margin: 0 }' }] });
  expect(fixed.diagnostics.filter((d) => d.code === 'SN529')).toEqual([]);
  expect(fixed.paint).toContain('width:280px');
  expect(fixed.paint).toContain('height:160px');
});

test('SN530: an image without a height in rows that arrive after the first paint', () => {
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: 'img { max-width: 100% } .avatar { width: 32px; height: 32px } .cover { aspect-ratio: 16 / 9; width: 100% }' }], paintCss: '/p.css' };
  const page = (img: string) => `<!doctype html><html><head></head><body><sn-resource name="people" src="/api/people" key="id"></sn-resource><ul><template data-sn-for="p in people"><li>${img}<span data-sn-text="p.name"></span></li></template></ul></body></html>`;
  const codes = (img: string) => compile(page(img), opts).diagnostics.filter((d) => d.code === 'SN530').length;
  expect(codes('<img data-sn-attr="{src: p.photo}" alt="">')).toBe(1);
  expect(codes('<img data-sn-attr="{src: p.photo}" width="400" height="300" alt="">')).toBe(0);
  expect(codes('<img class="avatar" data-sn-attr="{src: p.photo}" alt="">')).toBe(0);
  expect(codes('<img class="cover" data-sn-attr="{src: p.photo}" alt="">')).toBe(0);
});

test('SN530 suggests the fix for that image: its size from the API, the attribute it lacks, or an aspect-ratio rule for it', () => {
  const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
  const person = { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, photo: { type: 'object', properties: { url: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' } } }, avatar: { type: 'string' }, avatarWidth: { type: 'number' }, avatarHeight: { type: 'number' }, banner: { type: 'string' } } };
  const openapi = [{ file: '/app/openapi.json', doc: { openapi: '3.0.3', paths: { '/api/people': { get: { responses: { '200': json({ type: 'array', items: person }) } } } } } }];
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, openapi, styles: [{ file: 'a.css', css: 'img { max-width: 100% }' }], paintCss: '/p.css' };
  const hint = (img: string) => compile(`<!doctype html><html><head></head><body><sn-resource name="people" src="/api/people" key="id"></sn-resource><ul><template data-sn-for="p in people"><li class="person">${img}<span data-sn-text="p.name"></span></li></template></ul></body></html>`, opts).diagnostics.find((d) => d.code === 'SN530')?.hint;
  // the API's width and height next to the URL: bind them
  expect(hint('<img data-sn-attr="{src: p.photo.url}" alt="">')).toContain('add `width: p.photo.width, height: p.photo.height` to its `data-sn-attr`');
  expect(hint('<img data-sn-attr="{src: p.avatar, alt: p.name}" alt="">')).toContain('add `width: p.avatarWidth, height: p.avatarHeight`');
  // one attribute of the two
  expect(hint('<img data-sn-attr="{src: p.banner}" width="1200" alt="">')).toContain('give it `height` too');
  // no size in the API: a rule for it, by its row's class or its own
  expect(hint('<img data-sn-attr="{src: p.banner}" alt="">')).toContain('`.person img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; }`');
  expect(hint('<img class="banner" data-sn-attr="{src: p.banner}" alt="">')).toContain('`img.banner {');
});

test('indicators anywhere on the page: a `data-sn-show` or a branch elsewhere over the same status leaves the list without space; ones that never show while loading do not', () => {
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: CSS }], paintCss: '/p.css' };
  const list = '<sn-resource name="people" src="/api/people" items="people" key="id" paginate="offset" page-size="3"></sn-resource>';
  const tpl = '<ul><template data-sn-for="p in people"><li data-sn-text="p.name"></li></template></ul>';
  const page = (other: string) => compile(`<!doctype html><html><head></head><body>${list}${other}${tpl}</body></html>`, opts);
  expect(page('<p data-sn-show="$meta.people.loading">Loading…</p>').html).not.toContain('sn-reserve');
  expect(page('<header><template data-sn-if="$meta.people.loading"><span>…</span></template></header>').html).not.toContain('sn-reserve');
  // an error, a "loaded" note, a count once there are rows
  for (const quiet of ['<p data-sn-show="$meta.people.error">Failed</p>', '<template data-sn-if="!$meta.people.loading"><p>Done</p></template>', '<p data-sn-show="people.length > 0">Some</p>'])
    expect(page(quiet).html).toContain('sn-reserve');
  // one the build cannot evaluate: may show, so no space
  expect(page('<p data-sn-show="$meta.people.loading && Math.random() > 0.5">…</p>').html).not.toContain('sn-reserve');
});

test('a `src` that reads another resource: its load may not start at mount, no space and a note', () => {
  const page = `<sn-resource name="me" src="/api/me"></sn-resource>
    <sn-resource name="people" src="/api/people/{me.id}" items="people" key="id" paginate="offset" page-size="3"></sn-resource>
    <ul><template data-sn-for="p in people"><li data-sn-text="p.name"></li></template></ul>`;
  const out = compile(`<!doctype html><html><head></head><body>${page}</body></html>`, { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: CSS }], paintCss: '/p.css' });
  expect(out.html).not.toContain('sn-reserve');
  expect(JSON.stringify(out.unheld ?? out.diagnostics)).toContain('may not start when the page module mounts');
});

test('the `if` form\'s template stays after the rows: a `:last-child` rule never matches a row; per-row views are each list\'s own', () => {
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: CSS + ' li:last-child { height: 100px }' }], paintCss: '/p.css' };
  const page = (when: string) => compile(`<!doctype html><html><head></head><body>${PAGE('', `paginate="offset" page-size="3" ${when}`)}</body></html>`, opts).paint;
  expect(page('')).toContain('height:140px');
  expect(page('when="$url.go"')).toContain('height:60px');
  // two lists, one of each form, on one page
  const two = compile(`<!doctype html><html><head></head><body>${PAGE()}${PAGE('', 'paginate="offset" page-size="3" when="$url.go"').replace(/people/g, 'others')}</body></html>`, opts).paint;
  expect(two).toContain('height:140px');
  expect(two).toContain('height:60px');
});

test('rows a component\'s own `<style>` reaches: no space (the build reads the page\'s stylesheets only)', () => {
  const files: Record<string, string> = {
    '/app/src/components/person-row.html': '<template data-sn-component="{ name: string }"><li class="pr" data-sn-text="name"></li></template>\n<style>.pr { height: 10px }</style>\n',
    '/app/src/components/plain-row.html': '<template data-sn-component="{ name: string }"><li data-sn-text="name"></li></template>\n',
  };
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: (p: string) => { if (p in files) return files[p]!; throw new Error('missing'); }, moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: CSS }], paintCss: '/p.css' };
  const page = (tag: string) => compile(`<!doctype html><html><head></head><body>${PAGE().replace('<li data-sn-text="p.name"></li>', `<${tag} data-sn-prop="{ name: p.name }"></${tag}>`)}</body></html>`, opts);
  const styled = page('person-row');
  expect(styled.html).not.toContain('sn-reserve');
  expect(JSON.stringify(styled.unheld)).toContain('own `<style>`');
  expect(page('plain-row').html).toContain('sn-reserve');
});

test('SN529 in dev as in a build: the plan is the same, only the placeholder is the build\'s', () => {
  const css = '.row { display: flex; flex-wrap: wrap } .card { width: 280px; height: 40px; margin: 0 }';
  const page = `<!doctype html><html><head></head><body><sn-resource name="people" src="/api/people" items="people" key="id" paginate="offset" page-size="4"></sn-resource>
    <div class="row"><div class="feed"><template data-sn-for="p in people"><p class="card" data-sn-text="p.name"></p></template></div><aside>tags</aside></div></body></html>`;
  const opts = { file: '/app/index.html', root: '/app', readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css }] };
  const dev = compile(page, { ...opts, dev: true }), build = compile(page, { ...opts, dev: false, paintCss: '/p.css' });
  expect(dev.diagnostics.filter((d) => d.code === 'SN529')).toEqual([]);
  expect(build.diagnostics.filter((d) => d.code === 'SN529')).toEqual([]);
  expect(dev.html).not.toContain('sn-reserve');
  expect(build.html).toContain('sn-reserve');
});

test('with `embed`: a list the server fills holds no space; one it cannot fill still does', () => {
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: CSS }], paintCss: '/p.css', embed: true };
  const served = compile(`<!doctype html><html><head></head><body>${PAGE()}</body></html>`, opts);
  expect(served.html).not.toContain('sn-reserve');
  expect(JSON.stringify(served.unheld)).toContain('embedded by the server');
  // `early="off"`: not embedded, loaded by the page
  const own = compile(`<!doctype html><html><head></head><body>${PAGE('', 'paginate="offset" page-size="3" early="off"')}</body></html>`, opts);
  expect(own.html).toContain('sn-reserve');
});

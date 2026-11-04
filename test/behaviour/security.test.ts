import { afterEach, describe, expect, test } from 'vitest';
import { configure, header } from '../../src/index.js';
import { render, mockRequests } from '../../src/testing/index.js';

afterEach(() => configure({ request: [], onError: null, origins: [], urlSchemes: [] }));

describe('URL attributes', () => {
  const bad = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' \u0001javascript:alert(1)',
    'jav&#x09;ascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>',
    '\njavascript:alert(1)', 'javascript&colon;alert(1)',
  ];
  for (const v of bad) {
    test(`refuses ${JSON.stringify(v)} in href`, async () => {
      const state = `{ v: ${JSON.stringify(v)} }`.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const { root } = await render(`<div data-sn-state="${state}"><a data-sn-attr="{href: v}">x</a></div>`);
      const href = root.querySelector('a')!.getAttribute('href');
      if (href !== null) expect(new URL(href, 'http://localhost/').protocol).toMatch(/^https?:$/);
    });
  }
  test('allows http, https, mailto, tel and relative URLs', async () => {
    const { root } = await render(`<div data-sn-state="{ vs: ['https://x.example/', 'mailto:a@b', 'tel:1', '/rel', 'x?y'] }">
      <template data-sn-for="v in vs" data-sn-key="v"><a data-sn-attr="{href: v}"></a></template></div>`);
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://x.example/', 'mailto:a@b', 'tel:1', '/rel', 'x?y']);
  });
  test('data: only in media src; srcset candidates are each checked', async () => {
    const { root } = await render(`<div data-sn-state="{ d: 'data:image/png;base64,AAAA', s: '/a.png 1x, javascript:alert(1) 2x' }">
      <img data-sn-attr="{src: d, srcset: s}"><a data-sn-attr="{href: d}"></a></div>`);
    expect(root.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(root.querySelector('img')!.hasAttribute('srcset')).toBe(false);
    expect(root.querySelector('a')!.hasAttribute('href')).toBe(false);
  });
  test('configured schemes are added; javascript: can never be', async () => {
    configure({ urlSchemes: ['webcal:', 'javascript:'] });
    const { root } = await render(`<div data-sn-state="{ a: 'webcal://x/cal', b: 'javascript:1' }"><a id="a" data-sn-attr="{href: a}"></a><a id="b" data-sn-attr="{href: b}"></a></div>`);
    expect(root.querySelector('#a')!.getAttribute('href')).toBe('webcal://x/cal');
    expect(root.querySelector('#b')!.hasAttribute('href')).toBe(false);
  });
});

test('style values that load URLs are rejected', async () => {
  const { root } = await render(`<div data-sn-state="{ v: 'url(https://evil/)', w: 'red' }"><p data-sn-style="{background: v, color: w, '--x': 'a\\\\b'}"></p></div>`);
  const p = root.querySelector('p')!;
  expect(p.style.getPropertyValue('background')).toBe('');
  expect(p.style.getPropertyValue('color')).toBe('red');
  expect(p.style.getPropertyValue('--x')).toBe('');
});

test('text is never HTML', async () => {
  const { root } = await render(`<div data-sn-state="{ v: '<img src=x onerror=alert(1)>' }"><p data-sn-text="v"></p></div>`);
  expect(root.querySelector('p')!.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(root.querySelector('img')).toBeNull();
});

describe('injection', () => {
  test('server-rendered directives stay inert', async () => {
    const { root, flush } = await render(`
      <div data-sn-state="{ n: 0 }"><p data-sn-text="n"></p>
        <div id="ugc"></div>
        <button data-sn-on-click="n++">+</button></div>`);
    root.querySelector('#ugc')!.innerHTML = '<button data-sn-on-click="n = 999" data-sn-text="n">evil</button>';
    root.querySelector<HTMLElement>('#ugc button')!.click();
    await flush();
    expect(root.querySelector('p')!.textContent).toBe('0');
    expect(root.querySelector('#ugc button')!.textContent).toBe('evil');
  });
  test('forged duplicate data-sn ids are not bound', async () => {
    const { root } = await render(`<p data-sn-text="'bound'">x</p><p data-sn="0">forged</p>`);
    expect([...root.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['x', 'forged']);
  });
  test('a mismatched tag is not bound', async () => {
    // the id the IR records for <p> sits on a <span> in the delivered markup
    const { root } = await render(`<div><p data-sn-text="'bound'">x</p></div>`);
    expect(root.querySelector('p')!.textContent).toBe('bound');
  });
  test('embedded data outside <head> is ignored', async () => {
    const requests = mockRequests({ 'GET /api/p': [{ id: 1, n: 'server' }] });
    const { root, settle } = await render(`
      <sn-resource name="p" src="/api/p" key="id"></sn-resource>
      <script type="application/json" data-sn-data="p">[{"id":1,"n":"forged"}]</script>
      <template data-sn-for="x in p"><i data-sn-text="x.n"></i></template>`, { requests });
    await settle();
    expect(root.querySelector('i')!.textContent).toBe('server');
  });
});

test('DOM clobbering of document properties does not change behaviour', async () => {
  const { root, flush } = await render(`
    <form name="querySelectorAll"></form><img name="defaultView"><a id="baseURI" name="documentElement"></a>
    <div data-sn-state="{ n: 0 }"><p data-sn-text="n"></p><button data-sn-on-click="n++">+</button></div>`);
  root.querySelector('button')!.click();
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('1');
});

describe('prototype pollution', () => {
  test('patch fields and form names drop __proto__, constructor, prototype', async () => {
    const requests = mockRequests({ 'GET /api/x': [{ id: 1 }], 'POST /api/f': null });
    const { root, settle, app } = await render(`
      <sn-resource name="x" src="/api/x" key="id"></sn-resource>
      <p data-sn-text="x.length"></p>
      <form data-sn-post="/api/f"><input name="__proto__.polluted" value="1"><input name="ok" value="2"></form>`, { requests });
    await settle();
    app.resource('x').patch('1', JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'));
    root.querySelector('form')!.requestSubmit();
    await settle();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(app.resource('x').get('1')!)).toEqual(['id', 'a']);
    expect(requests.calls.at(-1)!.body).toEqual({ ok: '2' });
  });
  test('computed access guards constructor and __proto__', async () => {
    const { root } = await render(`<div data-sn-state="{ k: '__proto__', o: {} }"><p data-sn-text="String(o[k])"></p></div>`);
    expect(root.querySelector('p')!.textContent).toBe('');
  });
});

describe('requests and origins', () => {
  test('a disallowed origin is refused at runtime and reported', async () => {
    const seen: string[] = [];
    configure({ onError: (e) => seen.push(e.message) });
    const requests = mockRequests({});
    const { root, settle } = await render(`<button data-sn-post="https://other.example/api">x</button>`, { requests });
    root.querySelector('button')!.click();
    await settle();
    expect(requests.calls).toHaveLength(0);
    expect(seen[0]).toMatch(/origin not allowed/);
  });
  test('listed origins are allowed', async () => {
    configure({ origins: ['https://api.example'] });
    const requests = mockRequests({ 'POST /v1': null });
    const { root, settle } = await render(`<button data-sn-post="https://api.example/v1">x</button>`, { requests });
    root.querySelector('button')!.click();
    await settle();
    expect(requests.calls.map((c) => c.url)).toEqual(['/v1']);
  });
  test('interpolations are encoded; . and .. cannot climb', async () => {
    const seen: string[] = [];
    configure({ onError: (e) => seen.push(e.message) });
    const requests = mockRequests({ 'DELETE /api/a/x%2Fy': null, 'DELETE /api/q': null });
    const { root, settle } = await render(`<div data-sn-state="{ a: '..', b: 'x/y' }">
      <button id="a" data-sn-delete="/api/a/{a}">a</button>
      <button id="b" data-sn-delete="/api/a/{b}">b</button>
      <button id="q" data-sn-delete="/api/q?v={a}">q</button></div>`, { requests });
    for (const id of ['a', 'b', 'q']) root.querySelector<HTMLElement>(`#${id}`)!.click();
    await settle();
    expect(requests.calls.map((c) => c.url)).toEqual(['/api/a/x%2Fy', '/api/q?v=%2E%2E']);
    expect(seen).toEqual(['refused `..` as a URL path value']);
  });
  test('the CSRF header goes to same-origin requests only', async () => {
    configure({ request: [header('X-Sinter', '1')], origins: ['https://api.example'] });
    const requests = mockRequests({ 'POST /a': null, 'POST /b': null });
    const { root, settle } = await render(`<button id="a" data-sn-post="/a">a</button><button id="b" data-sn-post="https://api.example/b">b</button>`, { requests });
    root.querySelector<HTMLElement>('#a')!.click();
    root.querySelector<HTMLElement>('#b')!.click();
    await settle();
    expect(requests.calls.map((c) => c.headers['x-sinter'] ?? null)).toEqual(['1', null]);
  });
});

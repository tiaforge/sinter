// Write-through: a mutation's 2xx response is applied to the resources it is about, before `then`.
import { expect, test } from 'vitest';
import { render, mockRequests } from '../../src/testing/index.js';

const Article = { type: 'object', properties: { slug: { type: 'string' }, title: { type: 'string' }, favorited: { type: 'boolean' }, favoritesCount: { type: 'integer' }, author: { $ref: '#/components/schemas/Profile' } } };
const Profile = { type: 'object', properties: { username: { type: 'string' }, following: { type: 'boolean' } } };
const Comment = { type: 'object', properties: { id: { type: 'integer' }, body: { type: 'string' }, author: { $ref: '#/components/schemas/Profile' } } };
const json = (schema: unknown) => ({ description: 'ok', content: { 'application/json': { schema } } });
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const SPEC = {
  openapi: '3.0.3',
  paths: {
    '/api/articles': { get: { parameters: [{ name: 'tag', in: 'query' }], responses: { '200': json({ type: 'object', properties: { articles: { type: 'array', items: ref('Article') } } }) } } },
    '/api/articles/feed': { get: { responses: { '200': json({ type: 'object', properties: { articles: { type: 'array', items: ref('Article') } } }) } } },
    '/api/articles/{slug}': { get: { responses: { '200': json({ type: 'object', properties: { article: ref('Article') } }) } }, delete: { responses: { '204': { description: 'gone' } } } },
    '/api/articles/{slug}/favorite': { post: { responses: { '200': json({ type: 'object', properties: { article: ref('Article') } }) } }, delete: { responses: { '200': json({ type: 'object', properties: { article: ref('Article') } }) } } },
    '/api/profiles/{username}/follow': { post: { responses: { '200': json({ type: 'object', properties: { profile: ref('Profile') } }) } } },
    '/api/articles/{slug}/comments': {
      get: { responses: { '200': json({ type: 'object', properties: { comments: { type: 'array', items: ref('Comment') } } }) } },
      post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { comment: { type: 'object', properties: { body: { type: 'string' } } } } } } } }, responses: { '200': json({ type: 'object', properties: { comment: ref('Comment') } }) } },
    },
    '/api/articles/{slug}/comments/{id}': { delete: { responses: { '204': { description: 'gone' } } } },
    '/api/labels': {
      get: { responses: { '200': json({ type: 'object', properties: { labels: { type: 'array', items: ref('Label') } } }) } },
      post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } }, responses: { '200': json({ type: 'object', properties: { id: { type: 'integer' } } }) } },
    },
    '/api/labels/{id}': { put: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } }, responses: { '204': { description: 'ok' } } } },
    '/api/tags': { get: { responses: { '200': json({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }) } }, post: { responses: { '204': { description: 'ok' } } } },
  },
  components: { schemas: { Article, Profile, Comment, Label: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } } },
};
const a1 = { slug: 'a1', title: 'One', favorited: false, favoritesCount: 1, author: { username: 'ann', following: false } };
const a2 = { slug: 'a2', title: 'Two', favorited: false, favoritesCount: 0, author: { username: 'bob', following: false } };
const click = (root: ParentNode, sel: string) => root.querySelector<HTMLElement>(sel)!.click();

test('rule 1: the response Article patches the row in every list that holds it (by key), and the single resource the URL read', async () => {
  const requests = mockRequests({
    'GET /api/articles': { articles: [a1, a2] }, 'GET /api/articles/feed': { articles: [a1] }, 'GET /api/articles/a1': { article: a1 },
    'POST /api/articles/a1/favorite': { article: { ...a1, favorited: true, favoritesCount: 2 } },
  });
  const { root, settle } = await render(`
    <sn-resource name="articles" src="/api/articles" items="articles" key="slug"></sn-resource>
    <sn-resource name="feed" src="/api/articles/feed" items="articles" key="slug"></sn-resource>
    <sn-resource name="article" src="/api/articles/a1" items="article"></sn-resource>
    <ul id="l"><template data-sn-for="a in articles"><li data-sn-text="a.slug + ':' + a.favoritesCount"></li></template></ul>
    <ul id="f"><template data-sn-for="a in feed"><li data-sn-text="a.slug + ':' + a.favoritesCount"></li></template></ul>
    <p data-sn-text="article.favoritesCount + ':' + article.favorited"></p>
    <template data-sn-for="a in articles"><button class="fav" data-sn-post="/api/articles/{a.slug}/favorite">fav</button></template>`, { requests, openapi: SPEC });
  await settle();
  click(root, '.fav');
  await settle();
  expect([...root.querySelectorAll('#l li')].map((l) => l.textContent)).toEqual(['a1:2', 'a2:0']);
  expect([...root.querySelectorAll('#f li')].map((l) => l.textContent)).toEqual(['a1:2']);
  // the single `article` holds the same Article, but the URL named the row, not it: singles need provenance
  expect(root.querySelector('p')!.textContent).toBe('1:false');
});

test('rule 1 by provenance: a single resource the URL read is patched; a nested entity (article.author) is patched at its path', async () => {
  const requests = mockRequests({
    'GET /api/articles/a1': { article: a1 },
    'POST /api/articles/a1/favorite': { article: { ...a1, favorited: true, favoritesCount: 2 } },
    'POST /api/profiles/ann/follow': { profile: { username: 'ann', following: true } },
  });
  const { root, settle } = await render(`
    <sn-resource name="article" src="/api/articles/a1" items="article"></sn-resource>
    <p data-sn-text="article.favoritesCount + ':' + article.favorited + ':' + article.author.following + ':' + article.title"></p>
    <button id="fav" data-sn-post="/api/articles/{article.slug}/favorite">fav</button>
    <button id="follow" data-sn-post="/api/profiles/{article.author.username}/follow">follow</button>`, { requests, openapi: SPEC });
  await settle();
  click(root, '#fav'); await settle();
  expect(root.querySelector('p')!.textContent).toBe('2:true:false:One');
  click(root, '#follow'); await settle();
  expect(root.querySelector('p')!.textContent).toBe('2:true:true:One');
});

test('rule 2: a POST to the list\'s own URL inserts the created item; a POST elsewhere does not; `then` still runs after', async () => {
  const requests = mockRequests({
    'GET /api/articles/a1/comments': { comments: [{ id: 1, body: 'first', author: { username: 'ann', following: false } }] },
    'POST /api/articles/a1/comments': { comment: { id: 2, body: 'second', author: { username: 'bob', following: false } } },
    'GET /api/tags': { tags: ['x'] }, 'POST /api/tags': { status: 204 },
  });
  const { root, settle } = await render(`
    <div data-sn-state="{ slug: 'a1', body: 'second', saved: 0 }">
      <sn-resource name="comments" src="/api/articles/{slug}/comments" items="comments" key="id" order="-id"></sn-resource>
      <sn-resource name="tags" src="/api/tags" items="tags"></sn-resource>
      <ul><template data-sn-for="c in comments"><li data-sn-text="c.id + ':' + c.body"></li></template></ul>
      <form id="c" data-sn-post="/api/articles/{slug}/comments" data-sn-body="{comment: {body}}" data-sn-then="body = ''; saved = saved + 1"></form>
      <button id="t" data-sn-post="/api/tags">t</button>
      <i data-sn-text="body + '/' + saved"></i>
    </div>`, { requests, openapi: SPEC });
  await settle();
  root.querySelector<HTMLFormElement>('#c')!.requestSubmit(); await settle();
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['2:second', '1:first']);
  expect(root.querySelector('i')!.textContent).toBe('/1');
  click(root, '#t'); await settle();
  expect(requests.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
});

test('rule 2 without the item: body plus the returned key is the row; neither → the list is refetched', async () => {
  let id = 10;
  const requests = mockRequests({
    'GET /api/labels': () => ({ labels: [{ id: 1, name: 'a' }, ...(id > 11 ? [{ id: 99, name: 'server' }] : [])] }),
    'POST /api/labels': () => (++id == 11 ? { id } : { status: 204 }),
  });
  const { root, settle } = await render(`
    <div data-sn-state="{ name: 'b' }">
      <sn-resource name="labels" src="/api/labels" items="labels" key="id"></sn-resource>
      <ul><template data-sn-for="l in labels"><li data-sn-text="l.id + ':' + l.name"></li></template></ul>
      <form data-sn-post="/api/labels" data-sn-body="{name}"></form>
    </div>`, { requests, openapi: SPEC });
  await settle();
  const form = root.querySelector('form')!;
  form.requestSubmit(); await settle();
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['1:a', '11:b']);
  expect(requests.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  form.requestSubmit(); await settle();
  // 204 with nothing: a refetch brought the server's list
  expect(requests.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['1:a', '99:server']);
});

test('rule 3: a PUT body patches the row the URL named (unwrapped by the request schema; fields the item already has are left alone)', async () => {
  const requests = mockRequests({ 'GET /api/labels': { labels: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }, 'PUT /api/labels/2': { status: 204 } });
  const { root, settle } = await render(`
    <div data-sn-state="{ name: 'B!' }">
      <sn-resource name="labels" src="/api/labels" items="labels" key="id"></sn-resource>
      <ul><template data-sn-for="l in labels"><li><i data-sn-text="l.id + ':' + l.name"></i><button data-sn-put="/api/labels/{l.id}" data-sn-body="{name}">s</button></li></template></ul>
    </div>`, { requests, openapi: SPEC });
  await settle();
  root.querySelectorAll('button')[1]!.click(); await settle();
  expect([...root.querySelectorAll('li i')].map((l) => l.textContent)).toEqual(['1:a', '2:B!']);
});

test('rule 3 without a spec: the body patches the row only when its keys are fields of the row', async () => {
  const requests = mockRequests({ 'GET /api/m': { m: [{ id: 1, read: false }] }, 'PATCH /api/m/1': { status: 204 }, 'PATCH /api/other': { status: 204 } });
  const { root, settle } = await render(`
    <sn-resource name="m" src="/api/m" items="m" key="id"></sn-resource>
    <template data-sn-for="x in m"><div><p data-sn-text="x.id + ':' + x.read + ':' + ('extra' in x)"></p>
      <button id="a" data-sn-patch="/api/m/{x.id}" data-sn-body="{read: true}">a</button>
      <button id="b" data-sn-patch="/api/other" data-sn-body="{id: x.id, extra: 1}">b</button></div></template>`, { requests });
  await settle();
  click(root, '#b'); await settle();
  expect(root.querySelector('p')!.textContent).toBe('1:false:false');
  click(root, '#a'); await settle();
  expect(root.querySelector('p')!.textContent).toBe('1:true:false');
});

test('rule 4: a DELETE of a row\'s URL removes the row (no spec needed); a sub-resource DELETE does not; the single resource stays', async () => {
  const requests = mockRequests({
    'GET /api/articles/a1/comments': { comments: [{ id: 1, body: 'x' }, { id: 2, body: 'y' }] }, 'DELETE /api/articles/a1/comments/1': { status: 204 },
    'GET /api/articles/a1': { article: a1 }, 'DELETE /api/articles/a1/favorite': { status: 204 }, 'DELETE /api/articles/a1': { status: 204 },
  });
  const { root, settle } = await render(`
    <sn-resource name="article" src="/api/articles/a1" items="article"></sn-resource>
    <sn-resource name="comments" src="/api/articles/{article.slug}/comments" items="comments" key="id"></sn-resource>
    <ul><template data-sn-for="c in comments"><li><i data-sn-text="c.id"></i><button data-sn-delete="/api/articles/{article.slug}/comments/{c.id}">x</button></li></template></ul>
    <button id="unfav" data-sn-delete="/api/articles/{article.slug}/favorite">u</button>
    <button id="del" data-sn-delete="/api/articles/{article.slug}">d</button>
    <p data-sn-text="article ? article.slug : 'gone'"></p>`, { requests });
  await settle();
  root.querySelector('li button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
  expect([...root.querySelectorAll('li i')].map((l) => l.textContent)).toEqual(['2']);
  click(root, '#unfav'); click(root, '#del'); await settle();
  expect([...root.querySelectorAll('li i')].map((l) => l.textContent)).toEqual(['2']);
  expect(root.querySelector('p')!.textContent).toBe('a1');
});

test('order: write-through lands after the optimistic commit and before `then`, so `then` wins; a failure applies nothing', async () => {
  const requests = mockRequests({
    'GET /api/articles': { articles: [a1] },
    'POST /api/articles/a1/favorite': { article: { ...a1, favorited: true, favoritesCount: 5 } },
    'DELETE /api/articles/a1/favorite': { status: 500 },
  });
  const { root, settle } = await render(`
    <sn-resource name="articles" src="/api/articles" items="articles" key="slug"></sn-resource>
    <template data-sn-for="a in articles"><div><p data-sn-text="a.favoritesCount + ':' + a.favorited + ':' + a.title"></p>
      <button id="fav" data-sn-post="/api/articles/{a.slug}/favorite" data-sn-optimistic="patch(a, {favorited: true})" data-sn-then="patch(a, {title: 'then'})">f</button>
      <button id="unfav" data-sn-delete="/api/articles/{a.slug}/favorite" data-sn-optimistic="patch(a, {favorited: false})" data-sn-catch="$event.preventDefault()">u</button></div></template>`, { requests, openapi: SPEC });
  await settle();
  click(root, '#fav'); await settle();
  expect(root.querySelector('p')!.textContent).toBe('5:true:then');
  click(root, '#unfav'); await settle();
  expect(root.querySelector('p')!.textContent).toBe('5:true:then');
});

test('data-sn-apply="off" keeps the handler\'s work to itself', async () => {
  const requests = mockRequests({ 'GET /api/articles': { articles: [a1] }, 'POST /api/articles/a1/favorite': { article: { ...a1, favoritesCount: 5 } } });
  const { root, settle } = await render(`
    <sn-resource name="articles" src="/api/articles" items="articles" key="slug"></sn-resource>
    <template data-sn-for="a in articles"><div><p data-sn-text="a.favoritesCount"></p><button data-sn-post="/api/articles/{a.slug}/favorite" data-sn-apply="off">f</button></div></template>`, { requests, openapi: SPEC });
  await settle();
  click(root, 'button'); await settle();
  expect(root.querySelector('p')!.textContent).toBe('1');
});

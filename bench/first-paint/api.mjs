// mock RealWorld API, the same for every app: realistic payloads, no auth (signed out)
import { createServer } from 'node:http';
const author = (i) => ({ username: `author${i}`, bio: null, image: null, following: false });
const article = (i) => ({ slug: `article-${i}`, title: `How to build fast and correct pages, part ${i}`, description: `A look at first paint, data and hydration, number ${i}.`,
  body: `# Part ${i}\n\n` + 'Rendering correctly before the module has run means the first frame shows the real state. '.repeat(40), tagList: ['web', 'performance', `t${i % 4}`],
  createdAt: new Date(Date.UTC(2026, 9, 30 - i)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, 30 - i)).toISOString(), favorited: false, favoritesCount: i * 3, author: author(i) });
const routes = [
  [/^\/api\/articles\/([^/]+)\/comments$/, () => ({ comments: [1, 2, 3].map((n) => ({ id: n, createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z', body: `Comment ${n}: thanks for this, very clear.`, author: author(n + 10) })) })],
  [/^\/api\/articles\/feed/, () => ({ articles: [], articlesCount: 0 })],
  [/^\/api\/articles\/([^/?]+)$/, (m) => ({ article: { ...article(1), slug: m[1] } })],
  [/^\/api\/articles/, () => ({ articles: Array.from({ length: 10 }, (_, i) => article(i + 1)), articlesCount: 42 })],
  [/^\/api\/tags$/, () => ({ tags: ['web', 'performance', 'html', 'css', 'javascript', 'qwik', 'sinter', 'mpa', 'ssr', 'static'] })],
  [/^\/api\/user$/, () => null],
];
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  if (req.method == 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const path = req.url.split('?')[0];
  const hit = routes.find(([re]) => re.test(path));
  const body = hit ? hit[1](hit[0].exec(path)) : null;
  // the API's own time (database, logic): every caller waits for it, the browser and the servers alike
  const delay = +(process.env.DELAY ?? 0);
  if (delay) return setTimeout(() => send(res, path, body), delay);
  send(res, path, body);
}).listen(4400);

function send(res, path, body) {
  if (!body) { res.statusCode = path == '/api/user' ? 401 : 404; res.setHeader('Content-Type', 'application/json'); return res.end('{"errors":{"body":["unauthorized"]}}'); }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

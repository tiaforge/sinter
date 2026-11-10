// A fixed Conduit API over HTTPS, for audits that must not depend on api.realworld.show (its
// latency varies, and a sandbox may not reach it): Chrome resolves the API's host, and the pages'
// third-party stylesheet hosts, to this server (`--host-resolver-rules`, `--ignore-certificate-errors`;
// `--no-proxy-server`: a Chrome that picks up a proxy from the environment resolves hosts there, not here).
// Signed out only: GETs of articles, an article, its comments, tags and a profile; stylesheets empty.
// The same API over plain HTTP at `api.http`, for a server that fetches the pages' data (sinter-axum).
//   const api = await mockApi(); … api.flags (Chrome flags) … await api.close();
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOSTS = ['api.realworld.show', 'code.ionicframework.com', 'fonts.googleapis.com'];

const author = (i) => ({ username: `author${i % 4}`, bio: 'Writes about the web.', image: null, following: false });
const paragraph = 'Server-rendered pages and small scripts: what a reader sees first should not wait for code it does not need. '.repeat(4);
const body = (i) => `# Part ${i}\n\n${paragraph}\n\n## Details\n\n- one\n- two\n- three\n\n${paragraph}\n\n\`\`\`js\nconst x = ${i};\n\`\`\`\n\n${paragraph}`;
const article = (i) => ({
  slug: `article-${i}`, title: `How to build article ${i}`, description: `What article ${i} is about, in one line.`, body: body(i),
  tagList: ['web', 'html', i % 2 ? 'performance' : 'sinter'], createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), favorited: false, favoritesCount: i * 3, author: author(i),
});
const articles = Array.from({ length: 25 }, (_, i) => article(25 - i));
const comment = (i) => ({ id: i, body: `Comment ${i}: ${paragraph.slice(0, 120)}`, createdAt: new Date(Date.UTC(2026, 1, i + 1)).toISOString(), updatedAt: new Date(Date.UTC(2026, 1, i + 1)).toISOString(), author: author(i) });

function route(url) {
  const u = new URL(url, 'https://x'), p = u.pathname, q = u.searchParams;
  let m;
  if (p === '/api/tags') return { tags: ['web', 'html', 'performance', 'sinter', 'css', 'http'] };
  if (p === '/api/user') return { user: null };
  if ((m = p.match(/^\/api\/articles\/([^/]+)\/comments$/))) return { comments: Array.from({ length: 5 }, (_, i) => comment(i + 1)) };
  if ((m = p.match(/^\/api\/articles\/([^/]+)$/))) {
    const a = articles.find((x) => x.slug === m[1]);
    return a ? { article: a } : null;
  }
  if ((m = p.match(/^\/api\/profiles\/([^/]+)$/))) return { profile: author(Number(m[1].replace(/\D/g, '')) || 0) };
  if (p === '/api/articles' || p === '/api/articles/feed') {
    let list = articles;
    if (q.get('tag')) list = list.filter((a) => a.tagList.includes(q.get('tag')));
    if (q.get('author')) list = list.filter((a) => a.author.username === q.get('author'));
    const offset = Number(q.get('offset') ?? 0), limit = Number(q.get('limit') ?? 10);
    return { articles: list.slice(offset, offset + limit), articlesCount: list.length };
  }
  return null;
}

export async function mockApi({ port = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mock-api-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const handle = (api) => (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin ?? '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', Vary: 'Origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (api || req.headers.host?.startsWith('api.')) {
      const out = route(req.url);
      res.writeHead(out ? 200 : 404, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(out ?? { errors: { body: ['not found'] } }));
    }
    // the stylesheets: empty, as fast as a cached CDN copy
    res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=31536000' });
    res.end('');
  };
  const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, handle(false));
  const http = createHttpServer(handle(true));
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
  const at = `127.0.0.1:${server.address().port}`;
  const shut = (s) => new Promise((ok) => { s.closeAllConnections(); s.close(ok); });
  return {
    flags: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} ${at}`).join(', ')}`, '--ignore-certificate-errors', '--no-proxy-server'],
    http: `http://127.0.0.1:${http.address().port}`,
    close: async () => { await Promise.all([shut(server), shut(http)]); rmSync(dir, { recursive: true, force: true }); },
  };
}

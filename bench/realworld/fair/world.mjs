// One local "internet" for every implementation, so none gets a network the others don't:
// - api.realworld.show: a fixed Conduit API (the data of bench/realworld/mock-api.mjs), each answer after `delay` ms,
//   also over plain HTTP at `apiHttp` for a server that fetches the data itself (SvelteKit's SSR)
// - every other mapped host (Ionicons, Google Fonts CSS and files): recorded copies of the real files, served like a CDN
//   copy. `record: true` fetches a missing file once (through HTTPS_PROXY when set) and keeps it in `dir`/fixtures, with
//   its sha256 in fixtures/manifest.json; otherwise a miss is a 404 (and listed in `misses`).
// - static builds: one server for all, brotli for text, immutable hashed assets, HTTP/1.1, an SPA fallback.
// TLS and plain HTTP on the same port (protocol-relative links on an http:// page ask for http://).
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer as netServer } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { brotliCompressSync } from 'node:zlib';

export const HOSTS = ['api.realworld.show', 'code.ionicframework.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'demo.productionready.io', 'static.productionready.io'];

// --- the API's data: as in bench/realworld/mock-api.mjs
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
  const u = new URL(url, 'https://x'), p = u.pathname.replace(/\/+$/, ''), q = u.searchParams;
  let m;
  if (p === '/api/tags') return { tags: ['web', 'html', 'performance', 'sinter', 'css', 'http'] };
  if (p === '/api/user') return { user: null };
  if ((m = p.match(/^\/api\/articles\/([^/]+)\/comments$/))) return { comments: Array.from({ length: 5 }, (_, i) => comment(i + 1)) };
  if (p === '/api/articles' || p === '/api/articles/feed') {
    let list = articles;
    if (q.get('tag')) list = list.filter((a) => a.tagList.includes(q.get('tag')));
    if (q.get('author')) list = list.filter((a) => a.author.username === q.get('author'));
    const offset = Number(q.get('offset') ?? 0), limit = Number(q.get('limit') ?? 10);
    return { articles: list.slice(offset, offset + limit), articlesCount: list.length };
  }
  if ((m = p.match(/^\/api\/articles\/([^/]+)$/))) { const a = articles.find((x) => x.slug === m[1]); return a ? { article: a } : null; }
  if ((m = p.match(/^\/api\/profiles\/([^/]+)$/))) return { profile: author(Number(m[1].replace(/\D/g, '')) || 0) };
  return null;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const TEXT = /^(text\/|application\/(json|javascript|manifest)|image\/svg)/;

/** Both protocols on one port: a TLS ClientHello starts with 0x16. The front socket is piped to an internal HTTP or
 * HTTPS server (handing the socket over would lose the peeked bytes: a TLS socket reads from the raw handle). */
async function dual(handler, key, cert) {
  const h1 = httpServer(handler), h2 = httpsServer({ key, cert }, handler);
  const listen = (s) => new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s.address().port)));
  const p1 = await listen(h1), p2 = await listen(h2);
  const front = netServer((sock) => sock.once('data', (buf) => {
    const up = connect(buf[0] === 0x16 ? p2 : p1, '127.0.0.1', () => { up.write(buf); sock.pipe(up).pipe(sock); });
    const end = () => { sock.destroy(); up.destroy(); };
    sock.on('error', end); up.on('error', end); sock.on('close', end); up.on('close', end);
  }));
  front.on('connection', (s) => s.setNoDelay(true));
  await listen(front);
  return { port: front.address().port, close: () => new Promise((ok) => { h1.closeAllConnections(); h2.closeAllConnections(); front.close(); h1.close(); h2.close(ok); setTimeout(ok, 500); }) };
}

export async function world({ dir, delay = 150, record = false }) {
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  const keyF = join(dir, 'key.pem'), certF = join(dir, 'cert.pem');
  if (!existsSync(certF)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7', '-subj', '/CN=realworld-fixtures',
      '-addext', `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`, '-keyout', keyF, '-out', certF], { stdio: 'ignore' });
  }
  const key = readFileSync(keyF), cert = readFileSync(certF);
  // Chrome trusts only this certificate (by its public key), not every certificate
  const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  let dispatcher;
  const undici = record ? await import('undici') : null;
  if (record && process.env.HTTPS_PROXY) dispatcher = new undici.ProxyAgent(process.env.HTTPS_PROXY);
  const manifestFile = join(fixtures, 'manifest.json');
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
  const misses = new Set();
  const api = (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin ?? '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', Vary: 'Origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const out = route(req.url);
    setTimeout(() => {
      res.writeHead(out ? 200 : 404, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(out ?? { errors: { body: ['not found'] } }));
    }, delay);
  };
  const handler = async (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host === 'api.realworld.show' || host === '127.0.0.1') return api(req, res);
    const name = createHash('sha1').update(host + req.url).digest('hex');
    const file = join(fixtures, name), meta = file + '.json';
    if (!existsSync(file)) {
      if (!record) { misses.add(host + req.url); res.writeHead(404); return res.end(); }
      try {
        const r = await undici.fetch(`https://${host}${req.url}`, { dispatcher, headers: { 'user-agent': req.headers['user-agent'] ?? 'Mozilla/5.0', accept: req.headers.accept ?? '*/*' } });
        const buf = Buffer.from(await r.arrayBuffer());
        if (r.ok) {
          writeFileSync(file, buf); writeFileSync(meta, JSON.stringify({ url: host + req.url, type: r.headers.get('content-type') }));
          manifest[host + req.url] = { file: name, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
          writeFileSync(manifestFile, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2) + '\n');
        }
        else misses.add(`${host}${req.url} (${r.status})`);
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        return res.end(buf);
      } catch (e) { misses.add(`${host}${req.url} (${e.message})`); res.writeHead(502); return res.end(); }
    }
    const { type } = JSON.parse(readFileSync(meta, 'utf8'));
    let buf = readFileSync(file);
    const br = TEXT.test(type ?? '') && /\bbr\b/.test(req.headers['accept-encoding'] ?? '');
    if (br) buf = brotliCompressSync(buf);
    // like a CDN copy: cacheable, compressed, no extra wait
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000', 'Access-Control-Allow-Origin': '*', ...(br ? { 'Content-Encoding': 'br', Vary: 'Accept-Encoding' } : {}) });
    res.end(buf);
  };
  const srv = await dual(handler, key, cert);
  const at = `127.0.0.1:${srv.port}`;
  return {
    flags: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} ${at}`).join(', ')}`, `--ignore-certificate-errors-spki-list=${spki}`, '--no-proxy-server'],
    apiHttp: `http://${at}/api`,
    misses,
    /** sha256 over the manifest: which recorded files a run used */
    fixtures: () => existsSync(manifestFile) ? createHash('sha256').update(readFileSync(manifestFile)).digest('hex').slice(0, 16) : null,
    close: srv.close,
  };
}

/** A production build served the same way for every implementation. `routes`: [regexp, file] pairs; else the SPA's index.html. */
export async function serveStatic({ dist, routes = null, assets = /^\/(assets|_app\/immutable|static\/js|static\/css|chunk-|main-|polyfills-|styles-)|\.[0-9a-f]{8,}\.|-[A-Za-z0-9_-]{8}\.(js|css)$/ }) {
  dist = resolve(dist);
  const cache = new Map();
  const server = httpServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(dist, path));
    if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
    const page = routes?.find(([re]) => re.test(path))?.[1];
    if (page) file = join(dist, `${page}.html`);
    else if (!existsSync(file) || path.endsWith('/')) file = existsSync(join(file, 'index.html')) ? join(file, 'index.html') : join(dist, 'index.html');
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const br = TEXT.test(type) && /\bbr\b/.test(req.headers['accept-encoding'] ?? '');
    let buf = cache.get(file + br);
    if (!buf) { try { buf = readFileSync(file); } catch { res.writeHead(404); return res.end(); } if (br) buf = brotliCompressSync(buf); cache.set(file + br, buf); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': assets.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache', ...(br ? { 'Content-Encoding': 'br', Vary: 'Accept-Encoding' } : {}) });
    res.end(buf);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }) };
}

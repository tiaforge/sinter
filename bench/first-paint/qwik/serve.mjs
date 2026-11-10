// Qwik City in Node: gzip (as the sinter servers), static files from dist (Qwik's own cache headers), then SSR
import { createServer } from 'node:http';
import compression from 'compression';
import qwik from './server/entry.preview.js';
const { router, notFound, staticFile } = qwik;
const gzip = compression();
const chain = [gzip, staticFile, router, notFound];
createServer((req, res) => {
  let i = 0;
  const next = (e) => { if (e) { res.statusCode = 500; return res.end(String(e)); } const f = chain[i++]; if (f) f(req, res, next); };
  next();
}).listen(+process.argv[2]);

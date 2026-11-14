import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const a = process.argv, port = Number(a[a.indexOf('--port') + 1] || 4400);
createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  for (const f of [p, p + 'index.html', p + '/index.html']) {
    try { const b = readFileSync('dist' + f); res.writeHead(200, { 'content-type': f.endsWith('.xml') ? 'application/xml' : 'text/html' }); return res.end(b); } catch {}
  }
  res.writeHead(404); res.end('not found');
}).listen(port, '127.0.0.1');

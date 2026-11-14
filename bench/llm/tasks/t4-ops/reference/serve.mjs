// Vanilla reference for T4 (validates the grader): one HTML file for every path, the API port from API_PORT.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const a = process.argv, port = Number(a[a.indexOf('--port') + 1] || 4400), host = a.includes('--host') ? a[a.indexOf('--host') + 1] : '127.0.0.1';
createServer((req, res) => {
  if (req.url.startsWith('/app.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(new URL('app.js', import.meta.url))); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Ops</title><script>window.API='http://localhost:${process.env.API_PORT ?? 3001}/api'</script><main id="app"></main><script type="module" src="/app.js"></script>`);
}).listen(port, host);

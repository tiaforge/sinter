// Vanilla reference for T1 (validates the grader): one HTML file for every path.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const a = process.argv, port = Number(a[a.indexOf('--port') + 1] || 4400), host = a.includes('--host') ? a[a.indexOf('--host') + 1] : '127.0.0.1';
createServer((req, res) => {
  const file = req.url.startsWith('/app.js') ? 'app.js' : 'index.html';
  res.writeHead(200, { 'content-type': file.endsWith('js') ? 'text/javascript' : 'text/html' });
  res.end(readFileSync(new URL(file, import.meta.url)));
}).listen(port, host);

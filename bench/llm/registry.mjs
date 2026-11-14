#!/usr/bin/env node
// A local npm registry for runs against an unpublished build: each given package is served from its tarball (`npm pack`
// of a branch), as its `latest` next to its published versions; every other request is answered by registry.npmjs.org.
// Serve the starter with the library (create-sinter beside @tiaforge-ui/sinter), so `npm create sinter` works as it does
// for a real user.
//   node registry.mjs <package.tgz>… [--port 4873]
// Point the agent and the grader at it with NPM_CONFIG_REGISTRY=http://127.0.0.1:<port>/ (run.mjs --registry).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:https';

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '4873';
const base = `http://127.0.0.1:${port}`;
const served = args.filter((x, i) => x.endsWith('.tgz') && args[i - 1] !== '--port').map((tgz) => {
  const bytes = readFileSync(tgz);
  const pkg = JSON.parse(execFileSync('tar', ['-xzOf', tgz, 'package/package.json']).toString());
  const tarballPath = `/${pkg.name}/-/${pkg.name.split('/').pop()}-${pkg.version}.tgz`;
  return { tgz, bytes, pkg, tarballPath, dist: {
    tarball: base + tarballPath,
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  } };
});

/** GET from registry.npmjs.org (in the proxy's no-proxy list, so reached directly). */
const upstream = (path, headers) => new Promise((ok, fail) => {
  const r = request({ host: 'registry.npmjs.org', path, headers: { accept: headers.accept ?? 'application/json', 'accept-encoding': 'identity' } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
  });
  r.on('error', fail); r.end();
});

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    const tar = served.find((x) => x.tarballPath === path);
    if (tar) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(tar.bytes); }
    const own = served.find((x) => path === `/${x.pkg.name}`);
    if (own) {
      // the published packument, with this build added as `latest`
      const { pkg, dist } = own;
      const up = await upstream(`/${pkg.name.replace('/', '%2f')}`, { accept: 'application/json' });
      const doc = up.status === 200 ? JSON.parse(up.body) : { name: pkg.name, versions: {}, time: {}, 'dist-tags': {} };
      doc.versions[pkg.version] = { ...pkg, _id: `${pkg.name}@${pkg.version}`, dist };
      doc['dist-tags'].latest = pkg.version;
      doc.time = { ...doc.time, [pkg.version]: new Date().toISOString(), modified: new Date().toISOString() };
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(doc));
    }
    const up = await upstream(req.url, req.headers);
    res.writeHead(up.status, { 'content-type': up.type ?? 'application/json' }); res.end(up.body);
  } catch (e) { res.writeHead(502); res.end(String(e)); }
}).listen(Number(port), '127.0.0.1', () => console.log(`registry on ${base}/: ${served.map((x) => `${x.pkg.name}@${x.pkg.version}`).join(', ')}; the rest from npmjs`));

// The bytes each built page sends before its <body>, raw and gzip: what anchors-as-comments moves
// into the head (templates), per page of a build directory.
//   node head-bytes.mjs <dist dir> [more dirs…]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const pages = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === 'assets' ? [] : pages(p)) : f.endsWith('.html') ? [p] : [];
});
for (const dir of process.argv.slice(2)) {
  const rows = pages(dir).map((p) => {
    const html = readFileSync(p, 'utf8'), at = html.search(/<body[\s>]/i);
    if (at < 0) return null;
    const head = html.slice(0, at);
    return { page: relative(dir, p), head: head.length, headGzip: gzipSync(head, { level: 6 }).length, total: html.length, totalGzip: gzipSync(html, { level: 6 }).length };
  }).filter(Boolean);
  console.log(JSON.stringify({ dir, rows }, null, 1));
}

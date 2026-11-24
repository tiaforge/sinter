// smaps summary of this process: Rss by mapping kind
import { readFileSync } from 'node:fs';
export function smaps() {
  const t = readFileSync('/proc/self/smaps', 'utf8').split('\n'); const o = {}; let cur = null, size = 0;
  for (const l of t) {
    const m = /^([0-9a-f]+)-([0-9a-f]+) \S+ \S+ \S+ \S+\s*(.*)$/.exec(l);
    if (m) { size = (parseInt(m[2], 16) - parseInt(m[1], 16)) / 1048576; const p = m[3]; cur = p === '' ? (size >= 60 && size <= 64.5 ? 'anon~64M(arena)' : size === 0.25 || size===0.5|| size === 1 ? 'anon small' : 'anon other') : p.startsWith('[') ? p : p.includes('.node') ? 'native .node' : p.includes('/node') ? 'node bin' : 'file'; continue; }
    const r = /^Rss:\s+(\d+) kB/.exec(l); if (r && cur) { o[cur] = (o[cur] ?? 0) + +r[1] / 1024; }
  }
  for (const k in o) o[k] = +o[k].toFixed(1); return o;
}

// Lines of app source per RealWorld implementation: non-blank lines by file type, excluding
// tests, mocks, type declarations, build config and the shared theme CSS.
//   node loc.mjs <name>=<dir>[:<glob roots>] ...
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const EXT = new Set(['.html', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.css']);
const SKIP = /(^|\/)(node_modules|\.git|dist|build|e2e|playwright|cypress|__tests__|__mocks__|mocks?|tests?|static|public\/assets)(\/|$)|\.(spec|test|stories|d)\.[jt]sx?$|test-setup|setupTests|(^|\/)styles\.css$|\.generated\./;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rows = [];
for (const arg of process.argv.slice(2)) {
  const [name, spec] = arg.split('=');
  const [dir, roots = 'src'] = spec.split(':');
  const files = roots.split(',').flatMap((r) => {
    const p = join(dir, r);
    return statSync(p).isDirectory() ? walk(p) : [p];
  }).filter((f) => EXT.has(extname(f)) && !SKIP.test(relative(dir, f)) && !/WAS GENERATED|@generated/i.test(readFileSync(f, 'utf8').slice(0, 600)));
  const by = {};
  let total = 0;
  for (const f of files) {
    const n = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).length;
    by[extname(f)] = (by[extname(f)] ?? 0) + n;
    total += n;
  }
  rows.push({ name, files: files.length, total, by });
}
console.log('| implementation | files | lines | by type |');
console.log('| --- | ---: | ---: | --- |');
for (const r of rows.sort((a, b) => a.total - b.total)) {
  console.log(`| ${r.name} | ${r.files} | ${r.total} | ${Object.entries(r.by).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e.slice(1)} ${n}`).join(', ')} |`);
}

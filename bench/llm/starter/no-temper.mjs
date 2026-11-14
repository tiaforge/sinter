#!/usr/bin/env node
// TEMPORARY, for fairness: create-sinter's template without temper, so a sinter agent does no styling work the Astro
// and SvelteKit agents do not do either (SPEC.md § Against an unpublished sinter build). Applied by pack-branch.mjs
// --patch to the packed copy only; packages/create in the repo is not changed.
//   node starter/no-temper.mjs <packages/create directory>
// Every edit asserts it matched, so a changed template fails the pack instead of shipping half-patched.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const create = process.argv[2], t = join(create, 'template');
const read = (f) => readFileSync(join(t, f), 'utf8'), write = (f, s) => writeFileSync(join(t, f), s);
const edit = (f, fn) => { const s = read(f), n = fn(s); if (n === s) throw new Error(`${f}: nothing changed`); write(f, n); };
const must = (s, from, to = '') => { if (!s.includes(from)) throw new Error(`no match: ${from.slice(0, 60)}`); return s.replace(from, to); };

// temper's attributes for looks and layout (its whole vocabulary in this template), and its custom properties
const ATTRS = /\s+data-(variant|tone|layout|gap|size|align|justify|wrap|grow|muted|list|truncate|icon|self|badge|callout|pad)(="[^"]*")?(?=[\s>/])/g;
const markup = (s) => s
  .replace(/\s+data-sn-attr="\{ 'data-tone': [^"]*\}"/g, '') // task.html: the badge's bound tone
  .replace(ATTRS, '')
  .replace(/\s+style="--tm-[^"]*"/g, '')
  .replace(/<!--[^>]*temper[^>]*-->\n?\s*/g, '');

const pkg = JSON.parse(read('package.json'));
delete pkg.dependencies['@tiaforge-ui/temper'];
delete pkg.devDependencies['@tiaforge-ui/temper-inspect'];
pkg.scripts.check = 'sinter check';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

edit('vite.config.js', (s) => {
  s = must(s, "import temper from '@tiaforge-ui/temper/vite';\n");
  return s.replace(/\n\s*\/\/ temper check[^\n]*\n\s*\/\/[^\n]*\n\s*temper\(\{[^)]*\}\),/, '');
});
edit('AGENTS.md', (s) => s.replace(/- Styling: temper[\s\S]*?(?=\n- )/, '').replace(/\n{3,}/g, '\n\n'));
edit('README.md', (s) => s.split('\n').filter((l) => !/temper|--tm-|TM101/.test(l)).join('\n').replace(/^# Tasks: sinter \+ temper/m, '# Tasks: sinter'));
edit('src/sinter.types.ts', (s) => s.replace(/^import type \{\} from '@tiaforge-ui\/temper\/sinter';[^\n]*\n/m, ''));
for (const f of ['index.html', 'task.html', 'src/components/app-header.html', 'src/components/task-chart.html', 'src/layouts/app-layout.html']) edit(f, markup);
edit('src/toast.ts', (s) => s.replace(/^\/\/ A temper toast:/m, '// A toast:'));
write('src/style.css', `/* Plain styles. */
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { margin: 0 auto; max-width: 48rem; padding: 1rem; }
`);
// the starter package itself (its README and description, which `npm create` users may read)
const cpkg = JSON.parse(readFileSync(join(create, 'package.json'), 'utf8'));
for (const k of ['description']) if (typeof cpkg[k] === 'string') cpkg[k] = cpkg[k].replace(/ \+ temper| and temper(\s*\([^)]*\))?|, temper/g, '');
if (Array.isArray(cpkg.keywords)) cpkg.keywords = cpkg.keywords.filter((k) => !/temper/.test(k));
writeFileSync(join(create, 'package.json'), JSON.stringify(cpkg, null, 2) + '\n');
if (existsSync(join(create, 'README.md'))) writeFileSync(join(create, 'README.md'), readFileSync(join(create, 'README.md'), 'utf8').split('\n').filter((l) => !/temper|--tm-/.test(l)).join('\n'));
if (existsSync(join(create, 'index.js'))) edit('../index.js', (s) => s.replace(/sinter \+ temper app/g, 'sinter app').replace(/ and temper \(styles\)/g, ''));
console.log('create-sinter template: temper removed');

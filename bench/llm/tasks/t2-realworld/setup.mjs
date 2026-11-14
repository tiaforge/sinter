// Builds the T2 starting projects into <out>/<framework>/ (default /tmp/llmbench/bases).
//   sinter:    examples/realworld at this commit, depending on the published package instead of the repo, without
//              its copy of the RealWorld e2e suite (the other base has none either)
//   sveltekit: sveltejs/realworld df79670 (the commit the fair Lighthouse comparison uses), with the same two edits
//              as bench/realworld/fair: adapter-node, and REALWORLD_API for its server-side fetches
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? '/tmp/llmbench/bases';
const repo = new URL('../../../../', import.meta.url).pathname;
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const edit = (file, from, to) => {
  const s = readFileSync(file, 'utf8');
  if (!s.includes(from)) throw new Error(`${file}: no match for ${from}`);
  writeFileSync(file, s.replace(from, to));
};
const gitInit = (dir) => { sh('git', ['init', '-q'], dir); sh('git', ['add', '-A'], dir); sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-qm', 'base'], dir); };

// sinter
const s = join(out, 'sinter');
rmSync(s, { recursive: true, force: true });
cpSync(join(repo, 'examples/realworld'), s, { recursive: true, filter: (p) => !/\/(node_modules|dist|e2e|test-results|playwright-report)(\/|$)|e2e-local\.sh|e2e-seed\.mjs|playwright\.config\.ts$/.test(p) });
const pkg = JSON.parse(readFileSync(join(s, 'package.json'), 'utf8'));
pkg.dependencies['@tiaforge-ui/sinter'] = '^' + execFileSync('npm', ['view', '@tiaforge-ui/sinter', 'version']).toString().trim();
delete pkg.devDependencies['@playwright/test']; delete pkg.scripts.e2e;
writeFileSync(join(s, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
rmSync(join(s, 'package-lock.json'), { force: true });
edit(join(s, 'README.md'), 'npm install            # in the repo root first: npm run build', 'npm install');
gitInit(s);

// sveltekit
const v = join(out, 'sveltekit');
rmSync(v, { recursive: true, force: true });
sh('git', ['clone', '-q', 'https://github.com/sveltejs/realworld.git', v]);
sh('git', ['checkout', '-q', 'df796708040f5200ec572b28ab7f88ecee5794dd'], v);
rmSync(join(v, '.git'), { recursive: true, force: true });
edit(join(v, 'svelte.config.js'), "import adapter from '@sveltejs/adapter-vercel';", "import adapter from '@sveltejs/adapter-node';");
edit(join(v, 'src/lib/api.js'), "const base = 'https://api.realworld.show/api';",
  "const base = (typeof process !== 'undefined' && process.env?.REALWORLD_API) || 'https://api.realworld.show/api';");
const vp = JSON.parse(readFileSync(join(v, 'package.json'), 'utf8'));
delete vp.devDependencies['@sveltejs/adapter-vercel']; vp.devDependencies['@sveltejs/adapter-node'] = '^5.5.8';
delete vp.packageManager;
writeFileSync(join(v, 'package.json'), JSON.stringify(vp, null, '\t') + '\n');
for (const f of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) rmSync(join(v, f), { force: true });
gitInit(v);
console.log(`bases in ${out}: ${['sinter', 'sveltekit'].filter((d) => existsSync(join(out, d))).join(', ')}`);

// Builds every implementation in implementations.mjs into `work/` (or --work): clone, exact commit, submodules, the
// edits, install from the lockfile, build. Writes work/versions.json: each commit, the theme each build ships, and the
// tool versions used. sinter is the checkout's own examples/realworld (built with `npm run build` there).
//   node setup.mjs [--work dir] [--only dir,dir]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { IMPLEMENTATIONS, THEME } from './implementations.mjs';

const { values: opt } = parseArgs({ options: { work: { type: 'string', default: join(import.meta.dirname, 'work') }, only: { type: 'string' } } });
const work = resolve(opt.work);
mkdirSync(work, { recursive: true });
const run = (cmd, cwd) => { console.error(`  ${cwd.slice(work.length + 1) || '.'}$ ${cmd.join(' ')}`); execFileSync(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', 'ignore', 'inherit'] }); };
const out = (cmd, cwd) => { try { return execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8' }).trim(); } catch { return null; } };
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** pnpm refuses a lockfile with a duplicated key: drop entries that repeat an earlier one exactly (and fail on a real conflict) */
function dedupe(file) {
  const tops = readFileSync(file, 'utf8').split(/^(?=\S)/m);
  let removed = 0;
  const kept = tops.map((top) => {
    const seen = new Map();
    return top.split(/^(?=  \S)/m).filter((e) => {
      const key = /^ {2}(\S[^\n]*?):\s*(\n|$|\{)/.exec(e)?.[1];
      if (key === undefined) return true;
      if (seen.has(key)) {
        if (seen.get(key).trim() !== e.trim()) throw new Error(`${file}: two different entries for ${key}`);
        removed++;
        return false;
      }
      seen.set(key, e);
      return true;
    }).join('');
  });
  writeFileSync(file, kept.join(''));
  return removed;
}

const theme = join(work, 'realworld');
if (!existsSync(theme)) run(['git', 'clone', '-q', THEME.repo, 'realworld'], work);
run(['git', 'fetch', '-q', 'origin', THEME.commit], theme);
run(['git', 'checkout', '-q', '--force', THEME.commit], theme);
const themeFile = join(theme, THEME.file);

const versions = { date: new Date().toISOString(), theme: { ...THEME, sha256: sha(themeFile) }, tools: {}, implementations: {} };
for (const [k, cmd] of [['node', ['node', '-v']], ['npm', ['npm', '-v']], ['pnpm', ['pnpm', '-v']], ['bun', ['bun', '-v']]]) versions.tools[k] = out(cmd, work);
const only = opt.only?.split(',');
for (const impl of IMPLEMENTATIONS) {
  if (only && !only.includes(impl.dir)) continue;
  console.error(`${impl.name}`);
  const dir = join(work, impl.dir);
  if (!existsSync(dir)) run(['git', 'clone', '-q', impl.repo, impl.dir], work);
  run(['git', 'fetch', '-q', 'origin', impl.commit], dir);
  // a clean tree at the commit: earlier edits and installs are undone
  run(['git', 'checkout', '-q', '--force', impl.commit], dir);
  run(['git', 'clean', '-qfdx', '-e', 'node_modules'], dir);
  if (impl.submodules) run(['git', 'submodule', 'update', '--init', '--force', '-q'], dir);
  for (const e of impl.edits ?? []) {
    const file = join(dir, e.file), text = readFileSync(file, 'utf8');
    const n = typeof e.from === 'string' ? text.split(e.from).length - 1 : (text.match(new RegExp(e.from.source, 'g')) ?? []).length;
    if (n !== 1) throw new Error(`${impl.name}: ${e.file}: expected one match of ${e.from}, found ${n}`);
    writeFileSync(file, text.replace(e.from, e.to));
  }
  if (impl.dedupeLockfile) console.error(`  ${impl.dedupeLockfile}: ${dedupe(join(dir, impl.dedupeLockfile))} duplicate entries removed`);
  run(impl.install, dir);
  for (const c of impl.afterInstall ?? []) run(c, dir);
  run(impl.build, dir);
  if (impl.afterBuild?.copyTheme) copyFileSync(themeFile, join(dir, impl.afterBuild.copyTheme));
  const subs = impl.submodules ? out(['git', 'submodule', 'status'], dir) : null;
  versions.implementations[impl.name] = { repo: impl.repo, commit: impl.commit, ...(subs ? { submodules: subs } : {}), edits: (impl.edits ?? []).length };
}
// sinter: the checkout this harness is in
const sinter = resolve(import.meta.dirname, '../../..');
versions.implementations.sinter = { commit: out(['git', 'rev-parse', 'HEAD'], sinter), dirty: !!out(['git', 'status', '--porcelain', '--', 'src', 'examples/realworld'], sinter) };
writeFileSync(join(work, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
console.error(`versions: ${join(work, 'versions.json')}`);

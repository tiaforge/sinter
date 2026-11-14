#!/usr/bin/env node
// Packs sinter and its starter (create-sinter) from one commit, for registry.mjs:
//   node pack-branch.mjs <git ref> [--version 0.18.1] [--out /tmp/llmbench/registry]
// Both get the same version, above the published one, so `npm install @tiaforge-ui/sinter` and `npm create sinter`
// both resolve to the build, and the starter's `^0.18.0` takes the packed library. Prints the tarballs and the commit
// (for run.mjs --note).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a, positionals: [ref] } = parseArgs({ allowPositionals: true, options: {
  version: { type: 'string', default: '0.18.1' }, out: { type: 'string', default: '/tmp/llmbench/registry' },
  patch: { type: 'string' }, // a script run on the packed copy of packages/create (starter/no-temper.mjs); the repo is not changed
} });
if (!ref) throw new Error('usage: node pack-branch.mjs <git ref> [--version x.y.z] [--out dir]');
const repo = new URL('../../', import.meta.url).pathname, tree = join(a.out, 'tree');
const sh = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

mkdirSync(a.out, { recursive: true });
if (existsSync(tree)) sh('git', ['worktree', 'remove', '--force', tree]);
// a branch name is fetched from origin; a commit or a local ref is used as it is
let target = ref;
try { sh('git', ['fetch', '-q', 'origin', ref]); target = `origin/${ref}`; } catch { /* not a branch on origin */ }
const commit = sh('git', ['rev-parse', '--short', target]);
sh('git', ['worktree', 'add', '-q', '--detach', tree, commit]);
symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules')); // the build needs only the repo's own dev dependencies
sh('npm', ['run', 'build'], tree);
const setVersion = (dir) => { const f = join(dir, 'package.json'); const p = JSON.parse(readFileSync(f, 'utf8')); p.version = a.version; writeFileSync(f, JSON.stringify(p, null, 2) + '\n'); };
setVersion(tree); setVersion(join(tree, 'packages/create'));
if (a.patch) sh('node', [join(new URL('.', import.meta.url).pathname, a.patch), join(tree, 'packages/create')]);
const packs = [tree, join(tree, 'packages/create')].map((dir) => join(a.out, sh('npm', ['pack', '--silent', '--pack-destination', a.out], dir).split('\n').pop()));
sh('git', ['worktree', 'remove', '--force', tree]);
console.log(JSON.stringify({ commit, version: a.version, patch: a.patch ?? null, packs }, null, 2));

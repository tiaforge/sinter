#!/usr/bin/env node
// `npm create sinter [directory]`: copies the template (a sinter + temper app with a demo
// API) into a new directory. No dependencies; Node 20 or later.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const DEFAULT_DIR = 'tiaforge-app';
const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: npm create sinter [directory]

Creates a task board built with sinter (data) and temper (styles), with a demo API inside Vite.`);
  process.exit(0);
}

let dir = args.find((a) => !a.startsWith('-'));
if (!dir) {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    dir = (await rl.question(`Directory (${DEFAULT_DIR}): `)).trim() || DEFAULT_DIR;
    rl.close();
  } else {
    dir = DEFAULT_DIR;
  }
}

const target = resolve(dir);
if (existsSync(target) && readdirSync(target).length) {
  console.error(`${dir} is not empty. Choose a new directory.`);
  process.exit(1);
}

cpSync(join(import.meta.dirname, 'template'), target, { recursive: true });
// npm leaves .gitignore out of published packages, so the template carries it as _gitignore
renameSync(join(target, '_gitignore'), join(target, '.gitignore'));

const pkgPath = join(target, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.name = basename(target).toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[._-]+|-+$/g, '') || DEFAULT_DIR;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const pm = (process.env.npm_config_user_agent ?? 'npm').split('/')[0];
const run = pm === 'npm' ? 'npm run' : pm;
const cd = relative(process.cwd(), target) || '.';
console.log(`
Created ${cd}. Next:

  ${cd === '.' ? '' : `cd ${cd.includes(' ') ? JSON.stringify(cd) : cd}\n  `}${pm} install
  ${run} dev

The README lists what to try first.`);

// Cuts a release of the three published packages: `npm run release -- 0.3.0` bumps every place
// a version is written, dates the changelog's Unreleased section, commits "Release 0.3.0" and
// tags it (annotated), then prints the commands that push and publish. Nothing is pushed or
// published.
//
// - @tiaforge-ui/sinter (the repository root): 0.3.0, tagged v0.3.0.
// - @tiaforge-ui/create (packages/create, the starter): the same version, and its template
//   depends on ^0.3.0, the sinter about to be published, so publish sinter first.
// - sinter-axum and sinter-axum-macros (packages/sinter-axum, the middleware crates): versioned
//   on their own, tagged sinter-axum-v<version>. By default they take the same kind of bump as
//   sinter (major, minor or patch); `--axum=0.2.0` names the version.
//
// `--dry-run` prints the edits without writing; `--no-check` skips the typecheck and the tests
// (npm and cargo) that run before the commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const check = !args.includes('--no-check');
const version = args.find((a) => !a.startsWith('--'))?.replace(/^v/, '');
const axumArg = args.find((a) => a.startsWith('--axum='))?.slice('--axum='.length).replace(/^v/, '');
const unknown = args.filter((a) => a.startsWith('--') && !['--dry-run', '--no-check'].includes(a) && !a.startsWith('--axum='));

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const axumDir = resolve(root, 'packages/sinter-axum');
const cargo = (a, stdio = 'inherit') => execFileSync('cargo', a, { cwd: axumDir, stdio });

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const USAGE = 'usage: npm run release -- <x.y.z> [--axum=<x.y.z>] [--dry-run] [--no-check]';
if (!version || !SEMVER.test(version) || unknown.length) fail(USAGE);
if (axumArg !== undefined && !SEMVER.test(axumArg)) fail(USAGE);

const current = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const parts = (v) => SEMVER.exec(v).slice(1, 4).map(Number);
const cmp = (a, b) => parts(a).reduce((r, n, i) => r || n - parts(b)[i], 0);
if (cmp(version, current) < 0 || version === current) fail(`${version} is not newer than ${current}`);

// The middleware: the same kind of bump as sinter's, unless named.
const axumToml = readFileSync(resolve(axumDir, 'Cargo.toml'), 'utf8');
const axumCurrent = /^\[package\][^[]*?^version = "([^"]*)"/m.exec(axumToml)?.[1];
if (!axumCurrent) fail('no [package] version in packages/sinter-axum/Cargo.toml');
const bumped = (v, i) => parts(v).map((n, j) => (j < i ? n : j === i ? n + 1 : 0)).join('.');
const level = parts(version).findIndex((n, i) => n !== parts(current)[i]);
const axumVersion = axumArg ?? (level === -1 ? axumCurrent : bumped(axumCurrent, level));
if (cmp(axumVersion, axumCurrent) < 0 || axumVersion === axumCurrent) {
  fail(`sinter-axum ${axumVersion} is not newer than ${axumCurrent}; name one with --axum=<x.y.z>`);
}
const [axumMajor, axumMinor] = parts(axumVersion);

const tag = `v${version}`;
const axumTag = `sinter-axum-v${axumVersion}`;
for (const t of [tag, axumTag]) if (git('tag', '--list', t)) fail(`tag ${t} already exists`);
if (!dryRun && git('status', '--porcelain')) fail('the working tree is not clean; commit or stash first');

const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const [major, minor] = parts(version);

/** Each file, and the edit that bumps it; an edit that matches nothing stops the release. */
const edits = [
  ['package.json', (s) => s.replace(/("version": )"[^"]*"/, `$1"${version}"`)],
  // The root package's version, at the top and under packages[""].
  ['package-lock.json', (s) => s.replace(/^(  "version": )"[^"]*"/m, `$1"${version}"`)
    .replace(/(\n    "": \{\n      "name": "[^"]*",\n      "version": )"[^"]*"/, `$1"${version}"`)],
  // npm create @tiaforge-ui: released with sinter, and new apps get this version
  ['packages/create/package.json', (s) => s.replace(/("version": )"[^"]*"/, `$1"${version}"`)],
  ['packages/create/template/package.json', (s) => s.replace(/("@tiaforge-ui\/sinter": )"[^"]*"/, `$1"^${version}"`)],
  ['bench/js-framework-benchmark/package.json', (s) => s.replace(/("frameworkVersion": )"[^"]*"/, `$1"${version}"`)],
  ['README.md', (s) => s.replace(/sinter is at v\d+\.\d+/, `sinter is at v${major}.${minor}`)],
  // The middleware crates: both packages, the dependency between them, and the lockfile.
  ['packages/sinter-axum/Cargo.toml', (s) => s.replace(/^(\[package\][^[]*?^version = )"[^"]*"/m, `$1"${axumVersion}"`)
    .replace(/^(sinter-axum-macros = \{ version = )"[^"]*"/m, `$1"${axumVersion}"`)],
  ['packages/sinter-axum/macros/Cargo.toml', (s) => s.replace(/^(\[package\][^[]*?^version = )"[^"]*"/m, `$1"${axumVersion}"`)],
  ['packages/sinter-axum/Cargo.lock', (s) => s.replace(/(\nname = "sinter-axum"\nversion = )"[^"]*"/, `$1"${axumVersion}"`)
    .replace(/(\nname = "sinter-axum-macros"\nversion = )"[^"]*"/, `$1"${axumVersion}"`)],
  // `sinter-axum = "0.1"` and `sinter-axum = { version = "0.1", ... }` in its README
  ['packages/sinter-axum/README.md', (s) => s.replace(/(sinter-axum = (?:\{ version = )?)"[^"]*"/g, `$1"${axumMajor}.${axumMinor}"`)],
  ['CHANGELOG.md', (s) => s.replace(/^## Unreleased$/m, `## ${version} (${date})`)],
];

const changed = [];
for (const [file, edit] of edits) {
  const path = resolve(root, file);
  const before = readFileSync(path, 'utf8');
  const after = edit(before);
  // A README names only major.minor, so a patch release leaves it as it is.
  const sameMinor = file === 'README.md' ? major === parts(current)[0] && minor === parts(current)[1]
    : file === 'packages/sinter-axum/README.md' ? axumMajor === parts(axumCurrent)[0] && axumMinor === parts(axumCurrent)[1]
    : false;
  if (after === before && !sameMinor) {
    fail(file === 'CHANGELOG.md' ? 'CHANGELOG.md has no "## Unreleased" section' : `nothing to bump in ${file}`);
  }
  if (after !== before) changed.push([file, path, after]);
}

if (dryRun) {
  console.log(`release (dry run): sinter and create ${current} → ${version}, sinter-axum ${axumCurrent} → ${axumVersion}`);
  console.log('would change:');
  for (const [file] of changed) console.log(`  ${file}`);
  console.log(`then commit "Release ${version}" and tag ${tag} and ${axumTag}`);
  process.exit(0);
}

if (check) {
  const npm = (script) => execFileSync('npm', ['run', script], { cwd: root, stdio: 'inherit' });
  npm('typecheck');
  npm('test');
  cargo(['test', '--workspace']);
}

for (const [, path, after] of changed) writeFileSync(path, after);
// The lockfile edit must agree with the manifests: --locked fails if cargo would change it.
cargo(['metadata', '--locked', '--offline', '--format-version', '1', '--no-deps'], ['ignore', 'ignore', 'inherit']);
git('add', ...changed.map(([file]) => file));
git('commit', '-m', `Release ${version}`, '-m', `sinter-axum ${axumVersion}`);
git('tag', '-a', tag, '-m', `sinter ${version}`);
git('tag', '-a', axumTag, '-m', `sinter-axum ${axumVersion}`);

console.log(`
Released: commit "Release ${version}", tags ${tag} and ${axumTag}.
  @tiaforge-ui/sinter  ${version}
  @tiaforge-ui/create  ${version} (new apps get @tiaforge-ui/sinter ^${version})
  sinter-axum          ${axumVersion} (and sinter-axum-macros)

Push:
  git push origin HEAD ${tag} ${axumTag}

Publish, in this order (the starter needs sinter ${version} on npm, sinter-axum needs its macros on crates.io):
  npm publish
  (cd packages/create && npm publish)
  (cd packages/sinter-axum && cargo publish -p sinter-axum-macros && cargo publish -p sinter-axum)`);

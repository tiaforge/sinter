// Cuts a release of the published packages, all at one version so that equal versions are known
// to work together: `npm run release -- 0.3.0` bumps every place a version is written, dates the
// changelog's Unreleased section, commits "Release 0.3.0" and tags it v0.3.0 (annotated), runs
// every publish as a dry run, then prints the commands that push and publish. Nothing is pushed
// or published. If a dry run fails, the commit and the tag are taken back.
//
// - @tiaforge-ui/sinter (the repository root).
// - create-sinter (packages/create, the starter): its template depends on ^0.3.0, the
//   sinter about to be published, so publish sinter first, and on the latest @tiaforge-ui/temper
//   and @tiaforge-ui/temper-inspect on npm (looked up with `npm view`).
// - examples/dashboard, which StackBlitz installs from npm (the other examples use `file:../..`):
//   the same versions as the starter, so the link in the README runs the sinter just released.
// - sinter-axum and sinter-axum-macros (packages/sinter-axum, the middleware crates).
// - Sinter.AspNetCore (packages/sinter-aspnetcore, the ASP.NET Core middleware, on NuGet).
//
// `--dry-run` prints the edits without writing; `--no-check` skips the typecheck and the tests
// (npm, cargo and dotnet) that run before the commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const check = !args.includes('--no-check');
const version = args.find((a) => !a.startsWith('--'))?.replace(/^v/, '');
const unknown = args.filter((a) => a.startsWith('--') && !['--dry-run', '--no-check'].includes(a));

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const axumDir = resolve(root, 'packages/sinter-axum');
const cargo = (a, stdio = 'inherit') => execFileSync('cargo', a, { cwd: axumDir, stdio });
const netDir = resolve(root, 'packages/sinter-aspnetcore');
const dotnet = (a) => execFileSync('dotnet', a, { cwd: netDir, stdio: 'inherit' });

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
if (!version || !SEMVER.test(version) || unknown.length) fail('usage: npm run release -- <x.y.z> [--dry-run] [--no-check]');

const current = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const parts = (v) => SEMVER.exec(v).slice(1, 4).map(Number);
const cmp = (a, b) => parts(a).reduce((r, n, i) => r || n - parts(b)[i], 0);
if (cmp(version, current) < 0 || version === current) fail(`${version} is not newer than ${current}`);

// The middleware's current version; until the first release in step with sinter it may differ.
const axumToml = readFileSync(resolve(axumDir, 'Cargo.toml'), 'utf8');
const axumCurrent = /^\[package\][^[]*?^version = "([^"]*)"/m.exec(axumToml)?.[1];
if (!axumCurrent) fail('no [package] version in packages/sinter-axum/Cargo.toml');
if (cmp(version, axumCurrent) <= 0) fail(`${version} is not newer than sinter-axum's ${axumCurrent}`);

const tag = `v${version}`;
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`);

// The starter's temper and its inspector: the latest on npm.
const latest = (name) => {
  let v;
  try {
    v = execFileSync('npm', ['view', name, 'version'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    fail(`could not look up the latest ${name} on npm: ${String(e.stderr || e.message).trim()}`);
  }
  if (!SEMVER.test(v)) fail(`npm gave "${v}" as the latest ${name}`);
  return v;
};
const temper = latest('@tiaforge-ui/temper');
const inspect = latest('@tiaforge-ui/temper-inspect');
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
  // npm create sinter: released with sinter, and new apps get this version
  ['packages/create/package.json', (s) => s.replace(/("version": )"[^"]*"/, `$1"${version}"`)],
  ['packages/create/template/package.json', (s) => s.replace(/("@tiaforge-ui\/sinter": )"[^"]*"/, `$1"^${version}"`)
    .replace(/("@tiaforge-ui\/temper": )"[^"]*"/, `$1"^${temper}"`)
    .replace(/("@tiaforge-ui\/temper-inspect": )"[^"]*"/, `$1"^${inspect}"`)],
  // The dashboard opens on StackBlitz, which installs from npm: on 0.x a caret range stays within its
  // minor version, so without this it keeps running an older sinter than its pages are written for.
  ['examples/dashboard/package.json', (s) => s.replace(/("@tiaforge-ui\/sinter": )"[^"]*"/, `$1"^${version}"`)
    .replace(/("@tiaforge-ui\/temper": )"[^"]*"/, `$1"^${temper}"`)
    .replace(/("@tiaforge-ui\/temper-inspect": )"[^"]*"/, `$1"^${inspect}"`)],
  ['bench/js-framework-benchmark/package.json', (s) => s.replace(/("frameworkVersion": )"[^"]*"/, `$1"${version}"`)],
  ['README.md', (s) => s.replace(/sinter is at v\d+\.\d+/, `sinter is at v${major}.${minor}`)],
  // The middleware crates: both packages, the dependency between them, and the lockfile.
  ['packages/sinter-axum/Cargo.toml', (s) => s.replace(/^(\[package\][^[]*?^version = )"[^"]*"/m, `$1"${version}"`)
    .replace(/^(sinter-axum-macros = \{ version = )"[^"]*"/m, `$1"${version}"`)],
  ['packages/sinter-axum/macros/Cargo.toml', (s) => s.replace(/^(\[package\][^[]*?^version = )"[^"]*"/m, `$1"${version}"`)],
  ['packages/sinter-axum/Cargo.lock', (s) => s.replace(/(\nname = "sinter-axum"\nversion = )"[^"]*"/, `$1"${version}"`)
    .replace(/(\nname = "sinter-axum-macros"\nversion = )"[^"]*"/, `$1"${version}"`)],
  // `sinter-axum = "0.1"` and `sinter-axum = { version = "0.1", ... }` in its README
  ['packages/sinter-axum/README.md', (s) => s.replace(/(sinter-axum = (?:\{ version = )?)"[^"]*"/g, `$1"${major}.${minor}"`)],
  // The ASP.NET Core middleware: its version for every project, and the PackageReference in its README.
  ['packages/sinter-aspnetcore/Directory.Build.props', (s) => s.replace(/<Version>[^<]*<\/Version>/, `<Version>${version}</Version>`)],
  ['packages/sinter-aspnetcore/README.md', (s) => s.replace(/(Include="Sinter\.AspNetCore" Version=)"[^"]*"/g, `$1"${version}"`)],
  ['CHANGELOG.md', (s) => s.replace(/^## Unreleased$/m, `## ${version} (${date})`)],
];

const changed = [];
for (const [file, edit] of edits) {
  const path = resolve(root, file);
  const before = readFileSync(path, 'utf8');
  const after = edit(before);
  // A README names only major.minor, so a patch release leaves it as it is.
  const sameMinor = file === 'README.md' ? major === parts(current)[0] && minor === parts(current)[1]
    : file === 'packages/sinter-axum/README.md' ? major === parts(axumCurrent)[0] && minor === parts(axumCurrent)[1]
    : false;
  if (after === before && !sameMinor) {
    fail(file === 'CHANGELOG.md' ? 'CHANGELOG.md has no "## Unreleased" section' : `nothing to bump in ${file}`);
  }
  if (after !== before) changed.push([file, path, after]);
}

if (dryRun) {
  const from = axumCurrent === current ? current : `${current} (sinter-axum ${axumCurrent})`;
  console.log(`release ${from} → ${version} (dry run); the starter gets @tiaforge-ui/temper ^${temper} and temper-inspect ^${inspect}`);
  console.log('would change:');
  for (const [file] of changed) console.log(`  ${file}`);
  console.log(`then commit "Release ${version}" and tag ${tag}`);
  process.exit(0);
}

if (check) {
  const npm = (script) => execFileSync('npm', ['run', script], { cwd: root, stdio: 'inherit' });
  npm('typecheck');
  npm('test');
  cargo(['test', '--workspace']);
  dotnet(['test', '-c', 'Release']);
}

for (const [, path, after] of changed) writeFileSync(path, after);
// The lockfile edit must agree with the manifests: --locked fails if cargo would change it.
cargo(['metadata', '--locked', '--offline', '--format-version', '1', '--no-deps'], ['ignore', 'ignore', 'inherit']);
git('add', ...changed.map(([file]) => file));
git('commit', '-m', `Release ${version}`);
git('tag', '-a', tag, '-m', `sinter ${version}`);

// Every publish as a dry run, from the tagged commit. sinter's prepublishOnly (a clean build and the
// tests) is done here as a build only: the tests ran above, or were skipped with --no-check.
// `cargo publish --workspace` publishes the macros first and checks sinter-axum against them,
// which on its own would fail until the macros at this version are on crates.io.
const dryRuns = [
  ['@tiaforge-ui/sinter', () => {
    rmSync(resolve(root, 'dist'), { recursive: true, force: true });
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['publish', '--dry-run', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
  }],
  ['create-sinter', () => execFileSync('npm', ['publish', '--dry-run'], { cwd: resolve(root, 'packages/create'), stdio: 'inherit' })],
  ['sinter-axum and sinter-axum-macros', () => cargo(['publish', '--workspace', '--dry-run'])],
  ['Sinter.AspNetCore', () => dotnet(['pack', 'src/Sinter.AspNetCore', '-c', 'Release', '-o', 'artifacts'])],
];
for (const [name, run] of dryRuns) {
  console.log(`\nrelease: publish dry run of ${name}`);
  try {
    run();
  } catch {
    git('tag', '-d', tag);
    git('reset', '--hard', 'HEAD~1');
    fail(`the publish dry run of ${name} failed; took back the commit and the tag ${tag}`);
  }
}

console.log(`
Released: commit "Release ${version}", tag ${tag}. The publish dry runs passed.
All at ${version}: @tiaforge-ui/sinter, create-sinter (new apps get @tiaforge-ui/sinter ^${version}
and @tiaforge-ui/temper ^${temper}), sinter-axum and sinter-axum-macros, Sinter.AspNetCore.

Push:
  git push origin HEAD ${tag}

Publish, in this order (the starter needs sinter ${version} on npm, sinter-axum needs its macros on crates.io):
  npm publish
  (cd packages/create && npm publish)
  (cd packages/sinter-axum && cargo publish --workspace)
  dotnet nuget push packages/sinter-aspnetcore/artifacts/Sinter.AspNetCore.${version}.nupkg --source https://api.nuget.org/v3/index.json --api-key <key>`);

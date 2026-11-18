// Run by the Release workflow before anything is published: the tag of the GitHub release
// (v0.3.0) must be the version every package is at, which `npm run release -- 0.3.0` wrote and
// tagged (or the Release workflow, run from the Actions tab). A release made in GitHub's UI for a
// new tag, without that commit, stops here.
// `node scripts/release-check.mjs v0.3.0`; prints the npm dist-tag for the version (latest, or
// next for a pre-release such as 0.3.0-rc.1). With `--notes`, prints the version's CHANGELOG.md
// section instead, for the GitHub release.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tag = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
const version = tag.replace(/^v/, '');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const match = (file, re) => re.exec(read(file))?.[1];

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`release-check: "${tag}" is not a release tag (v<x.y.z>)`);
  process.exit(1);
}

const found = {
  'package.json': json('package.json').version,
  'packages/create/package.json': json('packages/create/package.json').version,
  'packages/sinter-markdown/package.json': json('packages/sinter-markdown/package.json').version,
  'packages/sinter-axum/Cargo.toml': match('packages/sinter-axum/Cargo.toml', /^\[package\][^[]*?^version = "([^"]*)"/m),
  'packages/sinter-axum/macros/Cargo.toml': match('packages/sinter-axum/macros/Cargo.toml', /^\[package\][^[]*?^version = "([^"]*)"/m),
  'packages/sinter-aspnetcore/Directory.Build.props': match('packages/sinter-aspnetcore/Directory.Build.props', /<Version>([^<]*)<\/Version>/),
};
const wrong = Object.entries(found).filter(([, v]) => v !== version);
if (wrong.length) {
  console.error(`release-check: the tag is ${tag}, but these are not at ${version}:`);
  for (const [file, v] of wrong) console.error(`  ${file}: ${v ?? '(no version)'}`);
  console.error(`Run the Release workflow with ${version} (Actions → Release → Run workflow), which bumps and tags; or \`npm run release -- ${version}\`, push its commit and tag, and make the GitHub release for that tag.`);
  process.exit(1);
}
if (process.argv.includes('--notes')) {
  const changelog = read('CHANGELOG.md');
  const start = changelog.search(new RegExp(`^## ${version.replace(/\./g, '\\.')} \\(`, 'm'));
  if (start < 0) {
    console.error(`release-check: CHANGELOG.md has no "## ${version} (…)" section`);
    process.exit(1);
  }
  const body = changelog.slice(changelog.indexOf('\n', start) + 1);
  const end = body.search(/^## /m);
  console.log((end < 0 ? body : body.slice(0, end)).trim());
} else {
  console.log(version.includes('-') ? 'next' : 'latest');
}

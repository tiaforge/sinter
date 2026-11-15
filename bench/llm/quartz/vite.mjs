// @qz/vite: the Quartz Vite plugin. It wraps the SvelteKit Vite plugin (which wraps vite-plugin-svelte):
//   - .qz components are translated to Svelte by a preprocessor (translate.mjs) before the compiler runs;
//   - src/pages/ (Quartz names) is mirrored into .quartz/routes/ (SvelteKit names), and SvelteKit's
//     `files.routes` points there; in dev a watcher keeps the mirror current;
//   - qz:app, qz:nav, qz:forms, qz:env/*, ~lib resolve to SvelteKit's modules.
// Usage, in vite.config.js:  plugins: [quartz({ server: 'node' })]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { translate, renameDataExports } from './translate.mjs';

const FILES = [
  [/^_view\.qz$/, '+page.qz'],
  [/^_frame\.qz$/, '+layout.qz'],
  [/^_failure\.qz$/, '+error.qz'],
  [/^_data\.server\.(js|ts)$/, '+page.server.$1'],
  [/^_data\.(js|ts)$/, '+page.$1'],
  [/^_frame\.data\.server\.(js|ts)$/, '+layout.server.$1'], // provisional names: the plan doesn't name layout data yet
  [/^_frame\.data\.(js|ts)$/, '+layout.$1'],
  [/^_endpoint\.(js|ts)$/, '+server.$1'],
];
const DATA_MODULE = /^\+(page|layout)(\.server)?\.(js|ts)$/;

const ALIASES = [
  [/^qz:app$/, '$app/state'],
  [/^qz:nav$/, '$app/navigation'],
  [/^qz:forms$/, '$app/forms'],
  [/^qz:env\/(.*)$/, '$env/$1'],
];
// ~lib → src/lib directly (SvelteKit 3 dropped the $lib alias for a #lib package import)
const LIB = /^~lib(?=\/|$)/;

/** One path segment of src/pages → its SvelteKit name. */
export function mirrorName(name, isDir) {
  if (isDir) {
    const group = /^\(\((.+)\)\)$/.exec(name);
    if (group) return `(${group[1]})`;
    return name.replace(/\{([^{}]+)\}/g, '[$1]');
  }
  for (const [re, to] of FILES) if (re.test(name)) return name.replace(re, to);
  return name;
}

/** Walks `pages` and returns Map(mirror path → { from, content }). */
function plan(pages, mirror) {
  const out = new Map();
  const walk = (src, dst) => {
    if (!fs.existsSync(src)) return;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, e.name), to = path.join(dst, mirrorName(e.name, e.isDirectory()));
      if (e.isDirectory()) walk(from, to);
      else if (e.isFile()) {
        let content = fs.readFileSync(from);
        if (DATA_MODULE.test(path.basename(to))) content = Buffer.from(renameDataExports(content.toString()));
        out.set(to, { from, content });
      }
    }
  };
  walk(pages, mirror);
  return out;
}

/** Brings `mirror` in line with `pages`, touching only files that changed. Returns Map(mirror path → source path). */
export function syncMirror(pages, mirror) {
  const want = plan(pages, mirror);
  for (const [to, { content }] of want) {
    if (fs.existsSync(to) && fs.readFileSync(to).equals(content)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content);
  }
  const prune = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { prune(p); if (!fs.readdirSync(p).length) fs.rmdirSync(p); }
      else if (!want.has(p)) fs.rmSync(p);
    }
  };
  prune(mirror);
  fs.mkdirSync(mirror, { recursive: true });
  return new Map([...want].map(([to, { from }]) => [to, from]));
}

/** The Svelte preprocessor for .qz files. `origin` maps a mirrored path back to its file in src/pages. */
export function quartzPreprocess({ origin = (f) => f } = {}) {
  return {
    name: 'quartz',
    markup({ content, filename }) {
      if (!filename?.endsWith('.qz')) return;
      return { code: translate(content, { filename: origin(filename) }) };
    },
  };
}

async function importFromApp(root, pkg, subpath = '.') {
  const req = createRequire(path.join(root, 'package.json'));
  const pkgJson = req.resolve(`${pkg}/package.json`);
  const exp = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).exports?.[subpath];
  const entry = typeof exp === 'string' ? exp : exp?.import ?? exp?.default;
  if (!entry) throw new Error(`quartz: cannot find the ESM entry of ${pkg}${subpath === '.' ? '' : subpath.slice(1)}`);
  return import(pathToFileURL(path.join(path.dirname(pkgJson), entry)).href);
}

/**
 * @param {object} [options]
 * @param {string} [options.pages] the Quartz pages directory (default src/pages)
 * @param {'node' | object} [options.server] an adapter, or 'node' for the Node adapter
 * Every other option is passed to SvelteKit's plugin.
 */
export async function quartz({ pages = 'src/pages', server, preprocess = [], ...rest } = {}) {
  const root = process.cwd();
  const libDir = path.resolve(root, 'src/lib');
  const pagesDir = path.resolve(root, pages), mirrorDir = path.resolve(root, '.quartz/routes');
  let origins = syncMirror(pagesDir, mirrorDir);
  const origin = (f) => origins.get(path.resolve(f)) ?? f;

  const { sveltekit } = await importFromApp(root, '@sveltejs/kit', './vite');
  const adapter = server === 'node' ? (await importFromApp(root, '@sveltejs/adapter-node')).default() : server;

  const kitPlugins = await sveltekit({
    ...rest,
    ...(adapter && { adapter }),
    extensions: ['.svelte', '.qz', ...(rest.extensions ?? [])],
    preprocess: [quartzPreprocess({ origin }), ...[preprocess].flat()],
    files: { ...rest.files, routes: path.relative(root, mirrorDir) },
  });

  /** @type {import('vite').Plugin} */
  const plugin = {
    name: 'quartz',
    enforce: 'pre',
    async resolveId(source, importer, opts) {
      if (LIB.test(source)) return this.resolve(source.replace(LIB, libDir), importer, { ...opts, skipSelf: true });
      for (const [re, to] of ALIASES) {
        if (re.test(source)) return this.resolve(source.replace(re, to), importer, { ...opts, skipSelf: true });
      }
      // a relative import in a mirrored file that points outside the mirror: resolve it from the original location
      if (importer && source.startsWith('.') && importer.startsWith(mirrorDir + path.sep)) {
        const file = importer.split('?')[0];
        if (!fs.existsSync(path.resolve(path.dirname(file), source.split('?')[0]))) {
          const orig = origins.get(file);
          if (orig) return this.resolve(path.resolve(path.dirname(orig), source), importer, { ...opts, skipSelf: true });
        }
      }
    },
    configureServer(server) {
      let timer;
      const watcher = fs.watch(pagesDir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try { origins = syncMirror(pagesDir, mirrorDir); } catch (e) { server.config.logger.error(`quartz: ${e.message}`); }
        }, 30);
      });
      server.httpServer?.on('close', () => watcher.close());
    },
  };
  return [plugin, ...kitPlugins];
}

export default quartz;

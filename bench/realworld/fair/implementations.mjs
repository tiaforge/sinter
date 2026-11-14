// The RealWorld implementations the fair comparison builds, each at an exact commit (the latest on its default branch
// on 2026-11-14), with the edits that point it at the same local API and theme as the others. Every edit asserts it
// matched, so a changed upstream file fails setup instead of silently measuring something else.
// Not included: React + Redux (gothinkster/react-redux-realworld-example-app, last commit 2021); not attempted.

/** Replace `from` (a string, or a RegExp) with `to` in a file's text, exactly once. Line endings stay as the file has them. */
const edit = (file, from, to) => ({ file, from, to });

export const THEME = { repo: 'https://github.com/realworld-apps/realworld.git', commit: '25588846c314b15a5e427ffe816e6b4af7be68c7', file: 'assets/theme/styles.css' };

export const IMPLEMENTATIONS = [
  {
    name: 'Angular', dir: 'angular', repo: 'https://github.com/realworld-apps/angular-realworld-example-app.git',
    commit: 'd426ec804f7d035c374aa4a1b48ecdb05a03eb02', submodules: true,
    // the official demo: it already uses api.realworld.show and the spec's theme (submodule `realworld` at THEME.commit)
    install: ['bun', 'install', '--frozen-lockfile'], build: ['bunx', 'ng', 'build'],
    dist: 'dist/angular-conduit/browser',
  },
  {
    name: 'Vue 3 (official)', dir: 'vue-official', repo: 'https://github.com/realworld-apps/vue-realworld-example-app.git',
    commit: 'db749e3bb1a45755e0a3f4065abaf7346f004f36', submodules: true,
    install: ['bun', 'install', '--frozen-lockfile'], build: ['bun', 'run', 'build'],
    dist: 'dist',
  },
  {
    name: 'Vue 3 (mutoe)', dir: 'vue', repo: 'https://github.com/mutoe/vue3-realworld-example-app.git',
    commit: '741c215ef0f674f90fcb03c5493a1b3a3a7f1b03',
    install: ['pnpm', 'install', '--frozen-lockfile'], build: ['pnpm', 'build'],
    dist: 'dist',
  },
  {
    name: 'SvelteKit', dir: 'svelte', repo: 'https://github.com/sveltejs/realworld.git',
    commit: 'df796708040f5200ec572b28ab7f88ecee5794dd',
    // its lockfile at this commit has two exact duplicate entries, which pnpm refuses to read
    dedupeLockfile: 'pnpm-lock.yaml',
    edits: [
      // served by its own Node server here (it deploys to Vercel), with the same adapter for every run
      edit('svelte.config.js', "import adapter from '@sveltejs/adapter-vercel';", "import adapter from '@sveltejs/adapter-node';"),
      // its server-side loads fetch the local API over plain HTTP; the browser keeps api.realworld.show
      edit('src/lib/api.js', "const base = 'https://api.realworld.show/api';",
        "const base = (typeof process !== 'undefined' && process.env?.REALWORLD_API) || 'https://api.realworld.show/api';"),
    ],
    install: ['pnpm', 'install', '--frozen-lockfile'],
    afterInstall: [['pnpm', 'add', '-D', '@sveltejs/adapter-node@5.5.8']],
    build: ['pnpm', 'build'],
    server: 'build/index.js',
  },
  {
    name: 'Solid', dir: 'solid', repo: 'https://github.com/solidjs/solid-realworld.git',
    commit: 'f6e77ecd652bf32f0dc9238f291313fd1af7e98b',
    edits: [
      // api.realworld.io no longer answers: the same API as the others
      edit('src/store/createAgent.js', 'const API_ROOT = "https://api.realworld.io/api";', 'const API_ROOT = "https://api.realworld.show/api";'),
      edit('public/index.html', '<link rel="preconnect" href="https://api.realworld.io" crossorigin />', '<link rel="preconnect" href="https://api.realworld.show" crossorigin />'),
      // its theme host (demo.productionready.io) answers 404: the spec's theme, served with the build like the others'
      edit('public/index.html', '<link rel="stylesheet" href="//demo.productionready.io/main.css" />', '<link rel="stylesheet" href="/styles.css" />'),
      edit('public/index.html', /\s*<link\s+rel="shortcut icon"[^>]*demo\.productionready\.io[^>]*\/>/, ''),
      edit('public/index.html', /\s*<link rel="preconnect" href="https:\/\/static\.productionready\.io" crossorigin \/>/, ''),
    ],
    install: ['npm', 'ci'], build: ['npm', 'run', 'build'],
    // its build empties public/ except index.html
    afterBuild: { copyTheme: 'public/styles.css' },
    dist: 'public',
  },
];

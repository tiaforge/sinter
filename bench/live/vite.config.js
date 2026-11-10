import { defineConfig } from 'vite';

// One build per variant: VARIANT=sinter|solid|svelte|vue vite build (build.mjs runs them all).
// Every page gets the same two tags first in the head: the harness and the shared stylesheet.
const variant = process.env.VARIANT;
// the grid's variants (apps/grid-<name>) use their framework's plugin; Vue's grid is Vapor mode (Vue 3.6, installed as vue36 beside 3.5)
const kind = variant.replace(/^grid-/, '');
const vapor = variant === 'grid-vue';
const plugins = {
  sinter: async () => (await import('@tiaforge-ui/sinter/vite')).default(),
  solid: async () => (await import('vite-plugin-solid')).default(),
  svelte: async () => (await import('@sveltejs/vite-plugin-svelte')).svelte(),
  vue: async () => (await import('@vitejs/plugin-vue')).default(vapor ? { compiler: await import('vue36/compiler-sfc') } : {}),
  ivi: async () => (await import('@ivi/rolldown')).ivi({ filter: { id: /\.js$/ } }),
  vanilla: async () => null,
};
const shell = {
  name: 'live-shell',
  transformIndexHtml: { order: 'post', handler: () => [
    { tag: 'script', attrs: { src: '/shared/harness.js' }, injectTo: 'head-prepend' },
    { tag: 'link', attrs: { rel: 'stylesheet', href: '/shared/style.css' }, injectTo: 'head' },
  ] },
};

export default defineConfig(async () => ({
  root: `apps/${variant}`,
  base: `/${variant}/`,
  publicDir: false,
  plugins: [await plugins[kind](), shell].filter(Boolean),
  ...(vapor ? { resolve: { alias: { vue: 'vue36' } } } : {}),
  // MINIFY=0: readable function names for profile.mjs
  build: { outDir: `../../dist/${variant}`, emptyOutDir: true, modulePreload: { polyfill: false }, minify: process.env.MINIFY !== '0' },
  server: { fs: { allow: ['../..'] } },
}));

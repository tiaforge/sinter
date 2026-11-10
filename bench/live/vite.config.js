import { defineConfig } from 'vite';

// One build per variant: VARIANT=sinter|solid|svelte|vue vite build (build.mjs runs them all).
// Every page gets the same two tags first in the head: the harness and the shared stylesheet.
const variant = process.env.VARIANT;
const plugins = {
  sinter: async () => (await import('@tiaforge-ui/sinter/vite')).default(),
  solid: async () => (await import('vite-plugin-solid')).default(),
  svelte: async () => (await import('@sveltejs/vite-plugin-svelte')).svelte(),
  vue: async () => (await import('@vitejs/plugin-vue')).default(),
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
  plugins: [await plugins[variant](), shell],
  build: { outDir: `../../dist/${variant}`, emptyOutDir: true, modulePreload: { polyfill: false } },
  server: { fs: { allow: ['../..'] } },
}));

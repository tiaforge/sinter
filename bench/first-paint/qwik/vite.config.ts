import { defineConfig } from 'vite';
import { qwikVite } from '@builder.io/qwik/optimizer';
import { qwikCity } from '@builder.io/qwik-city/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [qwikCity(), qwikVite()],
  resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
});

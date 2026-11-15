import { defineConfig } from 'vite';
import { quartz } from '../vite.mjs'; // becomes '@qz/vite' once the packages exist

export default defineConfig({
  plugins: [quartz({ server: 'node' })],
  // the incident API's port; the grader and the prompt use API_PORT (default 3001)
  define: { __API_PORT__: JSON.stringify(process.env.API_PORT ?? '3001') },
});

import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import { apis } from './apis.js';

export default defineConfig({
  plugins: [
    // the API and what each endpoint returns: apis.js
    // the pages' data-sn-path patterns are the routes: vite dev, vite preview, the build's _redirects and
    // sinter-axum serve /article/:slug from article.html, with nothing to write here
    // SINTER_EMBED=1: for a server that writes each page's data into it (packages/sinter-axum); the public
    // deployment is static, so off by default
    sinter({
      apis,
      // the article's body: <md-doc> renders the tree md.parse builds from its markdown (src/sinter.helpers.js)
      libraries: ['@tiaforge-ui/sinter-markdown'],
      // links and navigate() swap the next page in: the e2e suite's settings tests keep reading the page
      // after saving (docs/navigation.md#swaps)
      swap: true,
      // with embedded data (SINTER_EMBED), the article's body renders in the early script, its parser in the article's
      // early file (30.5 kB gzip), and the page module takes that instance (docs/first-paint.md#own-copies): its LCP is its
      // first paint, 1,359 ms on Lighthouse mobile through sinter-axum,
      // against 2,127 ms with the body rendered at mount (README.md). Without embedded data nothing of it is early
      firstPaint: { budget: 40 * 1024 },
      embed: !!process.env.SINTER_EMBED,
      strict: true,
    }),
  ],
  // sinter-markdown is linked from packages/ (file:): its imports of sinter resolve to the app's
  resolve: { dedupe: ['@tiaforge-ui/sinter'] },
});

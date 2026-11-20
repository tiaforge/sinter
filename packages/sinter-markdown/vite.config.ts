// The library's own config, for `sinter check` over its fixture pages (fixtures/*.html) and for the
// tests that build them. The fixture pages are configured as an app's would be, by the modules beside
// them: fixtures/sinter.helpers.ts re-exports the package as `md`, fixtures/sinter.types.ts names the
// tree's types. With no pages of its own here, `sinter check` takes the fixture pages (docs/libraries.md).
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: [sinter()],
});

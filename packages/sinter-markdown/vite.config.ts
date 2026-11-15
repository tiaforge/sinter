// The library's own config, for `sinter check` over its fixture pages (fixtures/*.html) and for the
// tests that build them. It configures the fixture pages as an app would: their helpers module
// re-exports the package as `md`, their types module names the tree's types. With no pages of its
// own here, `sinter check` takes the fixture pages (docs/libraries.md, "Checking a library").
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: [sinter({ helpers: 'fixtures/sinter.helpers.ts', types: 'fixtures/sinter.types.ts' })],
});

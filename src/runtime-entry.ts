// `@tiaforge-ui/sinter/runtime`: what the compiled page and early modules import, not the app. Its
// feature modules are `@tiaforge-ui/sinter/runtime/<feature>`; the app's API is the package's main entry.
export { mount } from './runtime/app.js';
export { $origins, $apis } from './runtime/config.js';
export { $k } from './runtime/keys.js';
export { $href, $hq, $hv } from './runtime/url.js';
export { date, relative, number, bytes } from './runtime/helpers.js';
export { parsed, rendered } from './runtime/env.js';

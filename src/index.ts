// The app's API. What compiled pages import (`mount`, the IR, features and the navigation hooks) is `@tiaforge-ui/sinter/runtime`.
export { instance, navigate, signOut, type App, type CallContext, type Transport } from './runtime/app.js';
export {
  configure, apiOf, header, onUnauthorized, loginRedirect, takeReturnUrl, clearStored, SinterError,
  type Config, type Middleware, type LoginRedirectOptions,
} from './runtime/config.js';
export type { Change, Meta } from './runtime/store.js';
import type { Resource as StoreResource } from './runtime/store.js';
/** A resource as the app sees it (`app.resource(name)`): its data, status and the store's changes */
export type Resource<T extends object = any> = Pick<StoreResource<T>, 'name' | 'meta' | 'key' | 'isCollection' | 'src' | 'order' | 'get' | 'has' | 'all' | 'value'
  | 'replace' | 'upsert' | 'merge' | 'remove' | 'refresh' | 'subscribe' | 'keyOf'>;
export { date, relative, number, bytes } from './runtime/helpers.js';
// for a component script that writes elements itself: the checks its markup's bindings would apply (docs/islands.md)
export { attrAllowed, styleAllowed } from './runtime/safe.js';

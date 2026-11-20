export { mount, instance, navigate, type App, type CallContext, type Feature, type Intent, type MountOptions, type Navigator, type Transport } from './runtime/app.js';
export {
  configure, apiOf, header, onUnauthorized, loginRedirect, takeReturnUrl, clearStored, SinterError,
  type Config, type Middleware, type LoginRedirectOptions,
} from './runtime/config.js';
export type { Change, Meta } from './runtime/store.js';
import type { Resource as StoreResource } from './runtime/store.js';
/** A resource as the app sees it (`app.resource(name)`): its data, status and the store's changes */
export type Resource<T extends object = any> = Pick<StoreResource<T>, 'name' | 'meta' | 'key' | 'isCollection' | 'get' | 'has' | 'all' | 'value'
  | 'replace' | 'upsert' | 'merge' | 'remove' | 'refresh' | 'subscribe' | 'keyOf'>;
export { date, relative, number, bytes } from './runtime/helpers.js';
export type { Env } from './runtime/env.js';
export type { IR } from './ir.js';

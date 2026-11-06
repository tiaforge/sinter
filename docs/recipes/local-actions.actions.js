// src/sinter.actions.js: functions pages call with data-sn-call and <sn-resource call>.
// The last argument is sinter's context; with JSDoc types, `sinter check` checks the calls.
/** @import { CallContext } from '@tiaforge-ui/sinter' */

/**
 * The file's SHA-256 as hex; choosing another file aborts the running hash through ctx.signal.
 * @param {File} file
 * @param {CallContext} ctx
 * @returns {Promise<string>}
 */
export async function sha256(file, ctx) {
  const bytes = await file.arrayBuffer();
  ctx.signal.throwIfAborted();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ctx.request goes through the app's middleware (headers, 401 handling, allowed origins).
 * @param {File} file
 * @param {string} digest
 * @param {CallContext} ctx
 * @returns {Promise<{ url: string }>}
 */
export async function upload(file, digest, ctx) {
  const form = new FormData();
  form.append('file', file);
  form.append('sha256', digest);
  return /** @type {Promise<{ url: string }>} */ (ctx.request('/api/uploads', { method: 'POST', body: form }));
}

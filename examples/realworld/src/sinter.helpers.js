// Helpers used in the pages' expressions.

/** The author's image, or the default avatar. */
export const avatar = (image) => image || '/default-avatar.svg';

/** Error lines for `.error-messages` from an `$error`. */
export function errors(error) {
  if (!error) return [];
  if (error.status === 0) return ['Unable to connect to the server. Please check your connection and try again.'];
  const e = error.body?.errors;
  if (e && typeof e === 'object') {
    return Object.entries(e).flatMap(([field, msgs]) =>
      (Array.isArray(msgs) ? msgs : [msgs]).map((m) => (field === 'body' || field === 'message' ? `${m}` : `${field} ${m}`)));
  }
  return [error.message || 'Something went wrong'];
}

/** Page numbers 1…n for `count` items, `size` per page. */
export const pages = (count, size) => Array.from({ length: Math.ceil((count || 0) / size) }, (_, i) => i + 1);

/** Offset of a 1-based page number from `$url.page`. */
export const offset = (page, size) => (Math.max(1, Number.parseInt(page, 10) || 1) - 1) * size;

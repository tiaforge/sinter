// Helpers used in the pages' expressions.

/** Markdown: `md.parse(article.body)`, the tree `<md-doc>` renders (@tiaforge-ui/sinter-markdown) */
export * as md from '@tiaforge-ui/sinter-markdown';

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

/** The page numbers 1…n of a paginated list (its `$meta.<name>.pages`). */
export const range = (n) => Array.from({ length: n ?? 0 }, (_, i) => i + 1);

/** The tag list with `tag` added (trimmed), unless it is empty or already there. */
export function withTag(list, tag) {
  const t = tag.trim();
  return !t || list.includes(t) ? list : [...list, t];
}

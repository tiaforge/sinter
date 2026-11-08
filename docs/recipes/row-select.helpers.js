// Helpers hold the logic; the page applies their result (`sel = rowClick(…)`).
// They are pure: the same arguments give the same result, nothing else is read or changed,
// so they are unit-tested without a page.

/** No row selected. */
export const noSelection = () => ({ keys: [], anchor: null });

/**
 * The selection after a click on the row `key`, as a file manager does it. `sel` is
 * `{ keys, anchor }`, `keys` the rows' keys in the order they are shown.
 * - a click selects only that row;
 * - Ctrl (Cmd on a Mac) adds or removes that row;
 * - Shift selects the rows from the anchor (the last row clicked without Shift) to this one;
 *   with Ctrl too, it adds them to the selection.
 */
export function rowClick(event, sel, key, keys) {
  const add = event.ctrlKey || event.metaKey;
  if (event.shiftKey && sel.anchor != null && keys.includes(sel.anchor)) {
    const a = keys.indexOf(sel.anchor), b = keys.indexOf(key);
    const range = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
    const chosen = new Set([...(add ? sel.keys : []), ...range]);
    return { keys: keys.filter((k) => chosen.has(k)), anchor: sel.anchor };
  }
  if (add) {
    const chosen = sel.keys.includes(key) ? sel.keys.filter((k) => k !== key) : [...sel.keys, key];
    return { keys: keys.filter((k) => chosen.includes(k)), anchor: key };
  }
  return { keys: [key], anchor: key };
}

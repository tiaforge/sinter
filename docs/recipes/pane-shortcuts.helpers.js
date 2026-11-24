// The pane's own event: what j and k send it (an expression cannot construct an event).

/** @param {number} by rows to move, 1 or -1 */
export const step = (by) => new CustomEvent('step', { detail: by });

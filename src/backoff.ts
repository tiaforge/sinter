// Waiting after failures, shared by the stream module (reconnects) and the refresh module
// (failed refreshes); core does not import it, so only pages with either carry it.

/** the longest wait between tries */
export const MAX_BACKOFF = 30_000;

/** the next wait after another failure: twice this one, up to `cap` */
export const doubled = (ms: number, cap = MAX_BACKOFF) => Math.min(ms * 2, cap);

/** `ms`, moved at random by up to `spread` of it either way, so clients that failed together do not retry together */
export const jittered = (ms: number, random: () => number, spread: number) => Math.round(ms * (1 - spread + random() * 2 * spread));

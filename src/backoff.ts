// Waiting after failures, shared by the stream module (reconnects) and the refresh module
// (failed refreshes), with the session probe the stream module and the retry module ask; core does not import it,
// so only pages with one of them carry it.
import { config } from './runtime/config.js';
import type { RequestLayer } from './runtime/request.js';

/** the longest wait between tries */
export const MAX_BACKOFF = 30_000;

/** the next wait after another failure: twice this one, up to `cap` */
export const doubled = (ms: number, cap = MAX_BACKOFF) => Math.min(ms * 2, cap);

/** `ms`, moved at random by up to `spread` of it either way, so clients that failed together do not retry together */
export const jittered = (ms: number, random: () => number, spread: number) => Math.round(ms * (1 - spread + random() * 2 * spread));

/** the session probe's status (0: a network error); it has no retry policy of its own */
export const probe = (layer: RequestLayer): Promise<number> => layer.raw(config.sessionProbe!, { retry: false }).then((r) => r.status, (e) => e?.status ?? 0);

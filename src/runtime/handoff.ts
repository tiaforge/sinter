// Where the early file and the page module meet. They are bundled apart (each holds its own copy
// of what it imports), so the two go through globals. Nothing else is in here: the early file
// imports it without the rest of the environment.

/**
 * Responses the early file requested before the page module ran, handed to the request layer
 * once each.
 */
export interface Prefetched {
  /** starts the request for a URL (once); `lo`: with low priority; `a`: its API's credentials, static headers and token */
  add(url: string, lo?: 1, a?: EarlyApi): void;
  /**
   * the response started for this request, if it is the request the early file sent (method, URL, credentials, headers);
   * null when one was sent for its URL and this request differs (a middleware changed it), undefined when none was
   */
  take(request: Request, signal: AbortSignal): Promise<Response> | null | undefined;
  /** aborts and forgets what no resource took */
  sweep(): void;
}
/**
 * What the early file sends a resource's request with: its API's credentials and static headers, and its token
 * (`t`: storage `l`ocal or `s`ession, key, header, what goes before it; `r`: the operation needs it, so without one
 * nothing is sent)
 */
export interface EarlyApi { c?: RequestCredentials; h?: Record<string, string>; t?: { s: 'l' | 's'; k: string; h: string; p: string }; r?: 1 }
const PREFETCHED = Symbol.for('sinter.prefetched');
export const prefetched = (): Prefetched | undefined => (globalThis as any)[PREFETCHED];
export const setPrefetched = (p: Prefetched) => { (globalThis as any)[PREFETCHED] = p; };

/** Whether the early file started, and when it has rendered. */
export interface Meeting { started: boolean; done: Promise<void>; finish(): void }
export const meeting = (): Meeting => ((globalThis as any)[Symbol.for('sinter.early.page')] ??= (() => {
  let finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });
  return { started: false, done, finish };
})());

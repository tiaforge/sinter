// Keys that could reach prototypes: apart from the URL checks (security.ts), so URL expansion and
// the early file can use them without bundling those.

/** Keys that could reach prototypes; dropped from input and refused in computed access. */
export const BAD_KEY = /^(constructor|__proto__|prototype)$/;

/** Guard for computed member access in expressions: `obj[k]` compiles to `obj[$k(k)]`. */
export const $k = <K>(key: K): K => {
  if (BAD_KEY.test(key as string)) throw TypeError(`sinter: [${String(key)}] is not allowed`);
  return key;
};

// The command line of `sinter check`, `sinter migrate` and `sinter render`: each argument as a flag and its value.

/** One argument: `name` is the flag without an inline value (`--root` of `--root=web`), or the argument as given. */
export interface Arg {
  /** the argument as given */
  flag: string;
  name: string;
  /** its value: inline (`--root=web`), else the next argument (`--root web`, which the loop then skips: read it in the loop); null at the end */
  value(): string | null;
  /** its value, or throws `<name> needs a value` (a string: the caller prints it) */
  need(): string;
}

/**
 * Each argument of `argv`, `--x v` and `--x=v` alike. A flag that `keep` matches is never split at its `=`: its value
 * holds one (`--input "#q=milk"` written `--input=#q=milk` is the flag `--input=#q=milk`, an unknown one).
 */
export function* args(argv: readonly string[], keep: RegExp = /$^/): Generator<Arg> {
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const split = flag.startsWith('--') && flag.includes('=') && !keep.test(flag);
    const name = split ? flag.slice(0, flag.indexOf('=')) : flag;
    const inline = split ? flag.slice(flag.indexOf('=') + 1) : undefined;
    const value = (): string | null => inline ?? argv[++i] ?? null;
    yield { flag, name, value, need: () => { const v = value(); if (v === null || v === '') throw `${name} needs a value`; return v; } };
  }
}

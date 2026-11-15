import { tokens } from '@fixture/heavy';

/** the words of a text, by the heavy package (lazy in an app that lists it in `sinter({ lazy })`) */
export function words(s: string): string[] {
  return tokens(s);
}

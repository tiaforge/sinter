// The parser, counting: every source it tokenizes is recorded in `globalThis.__parsed`. test/parses.test.ts
// builds an app with `@tiaforge-ui/sinter-markdown/parser` aliased to this module.
import { tokenize as real } from '../sinter/parser.js';

globalThis.__parsed = [];
export function tokenize(source) {
  globalThis.__parsed.push(source);
  return real(source);
}

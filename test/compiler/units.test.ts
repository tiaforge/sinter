// Units (docs/proposals/redesign-notes/stage4-units.md): a first pass's definitions compiled once per build (compile's
// `units`) and placed on every page that needs them. Each page must be what it is compiled without units, whichever page
// made the unit and in whatever order the pages come: byte for byte, but where its second pass placed a unit of its own
// (a page whose definitions ship, stage5-a1.md), whose numbers come first: there up to numbering (units2.test.ts).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { UNIT_STATS } from '../../src/compiler/units.js';
import { build, PAGES } from './units-pages.js';

// (stage 5, B1, takes a page's second pass from its first pass's walk where no unit is placed, and numbers it as the
// old route would not where a block's walk is dropped: the comparison of pages with and without units here is the
// units', with B1 off; test/compiler/from-walk.test.ts compares B1 with the old route)
const walk = process.env.SN_FROM_WALK;
beforeAll(() => { process.env.SN_FROM_WALK = '0'; });
afterAll(() => { if (walk === undefined) delete process.env.SN_FROM_WALK; else process.env.SN_FROM_WALK = walk; });

/** the page through `units` as compiled without them: byte for byte, or in canonical numbering where its second pass placed a unit */
function same(name: string, body: string, units: Map<string, unknown>, check: boolean, what: string) {
  const n = UNIT_STATS.made2 + UNIT_STATS.placed2;
  const through = build(name, body, units, check);
  if (UNIT_STATS.made2 + UNIT_STATS.placed2 === n) { expect(through, what).toEqual(build(name, body, undefined, check)); return; }
  process.env.SN_CANON = '1';
  try { expect(build(name, body, units, check), `${what} (up to numbering)`).toEqual(build(name, body, undefined, check)); } finally { delete process.env.SN_CANON; }
}

test('pages of every shape, through one build\'s units, in both orders: each as compiled without them', () => {
  const placed = UNIT_STATS.placed;
  for (const order of [Object.keys(PAGES), Object.keys(PAGES).reverse()]) {
    const units = new Map<string, unknown>();
    for (let round = 0; round < 2; round++) for (const name of order) same(name, PAGES[name]!, units, false, `${name}, round ${round}`);
  }
  expect(UNIT_STATS.placed).toBeGreaterThan(placed);
});

test('under the type check: each page, and its check unit, as compiled without units', () => {
  const placed = UNIT_STATS.placed;
  for (const order of [Object.keys(PAGES), Object.keys(PAGES).reverse()]) {
    const units = new Map<string, unknown>();
    for (let round = 0; round < 2; round++) for (const name of order) same(name, PAGES[name]!, units, true, `${name}, round ${round}`);
  }
  expect(UNIT_STATS.placed).toBeGreaterThan(placed);
});

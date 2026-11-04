// @vitest-environment jsdom
// The js-framework-benchmark entry, driven through the testing module: every
// operation the benchmark measures, plus the keyed checks it performs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { render } from '../src/testing/index.js';
// @ts-expect-error plain JS helpers module of the benchmark entry
import { rows } from '../bench/js-framework-benchmark/src/sinter.helpers.js';

const page = readFileSync(resolve(__dirname, '../bench/js-framework-benchmark/index.html'), 'utf8');

test('benchmark operations', async () => {
  const { root, flush } = await render(page, { helpers: { rows } });
  const click = async (sel: string) => { root.querySelector<HTMLElement>(sel)!.click(); await flush(); };
  const trs = () => [...root.querySelectorAll('tbody > tr')];
  const id = (i: number) => trs()[i]!.querySelector('td')!.textContent;
  const label = (i: number) => trs()[i]!.querySelector('a')!.textContent;

  await click('#run');
  expect(trs()).toHaveLength(1000);
  expect([id(0), id(999)]).toEqual(['1', '1000']);

  await click('#run');
  expect([trs().length, id(0)]).toEqual([1000, '1001']);

  await click('#add');
  expect([trs().length, id(1999)]).toEqual([2000, '3000']);

  await click('#update');
  expect(label(0)).toMatch(/ !!!$/);
  expect(label(1)).not.toMatch(/!!!/);
  expect(label(10)).toMatch(/ !!!$/);

  const [r1, r998] = [trs()[1], trs()[998]];
  await click('#swaprows');
  expect(trs()[1]).toBe(r998);
  expect(trs()[998]).toBe(r1);

  await click('tbody > tr:nth-of-type(5) td:nth-of-type(2) a');
  expect(trs()[4]!.className).toBe('danger');
  expect(trs().filter((t) => t.className == 'danger')).toHaveLength(1);

  const third = trs()[3];
  const removed = id(2);
  await click('tbody > tr:nth-of-type(3) td:nth-of-type(3) a');
  expect(trs()).toHaveLength(1999);
  expect(trs()[2]).toBe(third);
  expect(trs().some((t) => t.firstElementChild!.textContent == removed)).toBe(false);

  await click('#clear');
  expect(trs()).toHaveLength(0);

  await click('#runlots');
  expect(trs()).toHaveLength(10000);
}, 30_000);

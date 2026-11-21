// The command line of sinter's commands (src/args.ts): `--x v` and `--x=v` alike.
import { expect, test } from 'vitest';
import { args } from '../src/args.js';

// (a flag's value is read in the loop, before the next argument: reading it takes the next one)
const read = (argv: string[], keep?: RegExp) => { const out = []; for (const a of args(argv, keep)) out.push([a.name, a.name.startsWith('--') ? a.value() : null]); return out; };

test('a flag takes its value inline or from the next argument; the rest are as given', () => {
  expect(read(['--root', 'web', '--root=app', 'page.html', '--write'])).toEqual([['--root', 'web'], ['--root', 'app'], ['page.html', null], ['--write', null]]);
});

test('`need` refuses a missing or empty value; `keep` leaves a flag whose value holds `=` whole', () => {
  const [a] = [...args(['--url'])];
  expect(() => a!.need()).toThrow('--url needs a value');
  const [b] = [...args(['--url='])];
  expect(() => b!.need()).toThrow('--url needs a value');
  expect(read(['--input=#q=milk'], /^--input=/)).toEqual([['--input=#q=milk', null]]);
});

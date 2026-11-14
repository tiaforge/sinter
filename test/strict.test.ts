// `sinter check --strict`: warnings fail the check, except the machine's and the heuristics',
// and the codes passed to `--allow`. Build warnings carry a code.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { applyStrict, CODES, strictOf, ENVIRONMENT_CODES, formatWarning, HEURISTIC_CODES, severityOf, type Code, type Diagnostic } from '../src/compiler/diagnostics.js';

const at = { file: 'index.html', line: 1, col: 1 };
const warning = (code: string): Diagnostic => ({ severity: 'warning', code, message: 'm', ...at });

test('applyStrict promotes warnings, keeps environment, heuristic and allowed codes, and leaves errors alone', () => {
  const out = applyStrict([warning('SN501'), warning('SN518'), warning('SN524'), warning('SN507'), { severity: 'error', code: 'SN201', message: 'e', ...at }], new Set(['SN518']));
  expect(out.map((d) => `${d.code} ${d.severity}`)).toEqual(['SN501 error', 'SN518 warning', 'SN524 warning', 'SN507 warning', 'SN201 error']);
  expect(out[0]!.hint).toContain('--allow SN501');
  expect(out[4]!.hint).toBeUndefined();
});

test('the codes strict mode skips are warnings, and every build warning prints its code and docs', () => {
  for (const c of [...ENVIRONMENT_CODES, ...HEURISTIC_CODES]) expect(severityOf(c as Code)).toBe('warning');
  expect(formatWarning('SN519', 'x')).toBe(`sinter: warning SN519 ${CODES.SN519}: x\n  docs: https://github.com/tiaforge/sinter/blob/main/docs/diagnostics.md#sn519-unused-preload`);
});

const root = mkdtempSync(join(tmpdir(), 'sinter-strict-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'index.html'), `<!doctype html><html lang="en"><head><title>t</title></head><body>
<sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" type="any"></sn-resource>
</body></html>`);

const cli = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [resolve(__dirname, '../node_modules/jiti/lib/jiti-cli.mjs'), resolve(__dirname, '../src/cli.ts'), 'check', '--root', root, ...args, 'index.html'], { encoding: 'utf8', env: { ...process.env, SINTER_STRICT: '', ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('sinter check: a warning passes, --strict and SINTER_STRICT fail on it, --allow keeps it a warning', { timeout: 30_000 }, () => {
  const plain = cli([]);
  expect(plain.code).toBe(0);
  expect(plain.out).toContain('warning SN501 unused-resource');

  const strict = cli(['--strict']);
  expect(strict.code).toBe(1);
  expect(strict.out).toContain('error SN501 unused-resource');
  expect(strict.out).toContain('sinter check --strict: 1 page(s), 1 error(s) (1 were warnings), 0 warning(s)');

  expect(cli([], { SINTER_STRICT: '1' }).code).toBe(1);
  expect(cli(['--allow', 'sn501'], { SINTER_STRICT: '1' }).code).toBe(0);
  expect(cli(['--allow', 'nope']).code).toBe(2);
});

test('strictOf: SINTER_STRICT wins over the option; allow takes known codes with reasons', () => {
  expect(strictOf(undefined, undefined).on).toBe(false);
  expect(strictOf(true, undefined).on).toBe(true);
  expect(strictOf(true, '0').on).toBe(false);
  expect(strictOf(false, '1').on).toBe(true);
  expect(strictOf(undefined, '').on).toBe(false);
  const s = strictOf({ allow: { SN504: 'no types yet' } }, undefined);
  expect([s.on, [...s.allow]]).toEqual([true, [['SN504', 'no types yet']]]);
  expect(() => strictOf({ allow: { SN504: ' ' } }, undefined)).toThrow(/takes the reason/);
  expect(() => strictOf({ allow: { SN1: 'x' } }, undefined)).toThrow(/not a diagnostic code/);
  expect(() => strictOf({ alow: {} }, undefined)).toThrow(/`alow` is not an option/);
  expect(() => strictOf('yes', undefined)).toThrow(/takes `true`, `false`/);
});

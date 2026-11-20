import { expect, test } from 'vitest';
import { authOf } from '../../src/compiler/openapi.js';

const schemes = { bearer: { type: 'http', scheme: 'bearer' }, key: { type: 'apiKey', in: 'header', name: 'X-Key' }, q: { type: 'apiKey', in: 'query', name: 'k' }, sid: { type: 'apiKey', in: 'cookie', name: 'sid' }, tls: { type: 'mutualTLS' }, oauth: { type: 'oauth2', flows: {} }, ref: { $ref: '#/components/securitySchemes/sid' } };
const doc = (security?: unknown[]) => ({ components: { securitySchemes: schemes }, ...(security ? { security } : {}) });

test('the operation\'s security, else the document\'s: public, browser, optional, token, or unknown', () => {
  expect(authOf(doc(), {})).toBeNull();
  expect(authOf(doc([]), {})).toBe('public');
  expect(authOf(doc([{ bearer: [] }]), {})).toBe('token');
  expect(authOf(doc([{ bearer: [] }]), { security: [] })).toBe('public');
  // no credentials, or a token: the answer may differ with one (a signed-in view), so it is not the same for everyone
  expect(authOf(doc(), { security: [{ bearer: [] }, {}] })).toBe('optional');
  expect(authOf(doc(), { security: [{}, { key: [] }] })).toBe('optional');
  expect(authOf(doc(), { security: [{}] })).toBe('public');
  expect(authOf(doc(), { security: [{}, { sid: [] }] })).toBe('browser');
  for (const s of ['key', 'q', 'oauth']) expect(authOf(doc(), { security: [{ [s]: [] }] })).toBe('token');
  expect(authOf(doc(), { security: [{ sid: [] }] })).toBe('browser');
  expect(authOf(doc(), { security: [{ ref: [] }] })).toBe('browser');
  expect(authOf(doc(), { security: [{ tls: [] }] })).toBe('browser');
  // a cookie alternative: the browser can answer it alone; a cookie and a header together need the token
  expect(authOf(doc(), { security: [{ bearer: [] }, { sid: [] }] })).toBe('browser');
  expect(authOf(doc(), { security: [{ bearer: [], sid: [] }] })).toBe('token');
  // a scheme the document does not declare: unknown
  expect(authOf(doc(), { security: [{ nope: [] }] })).toBeNull();
});

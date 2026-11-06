import { expect, test } from 'vitest';
import { checkPage } from '@tiaforge-ui/sinter/check';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import * as actions from './local-actions.actions.js';
import source from './local-actions.actions.js?raw';
import page from './local-actions.html?raw';

const DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // sha256('abc')

function choose(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('hashes the chosen file, then uploads it with its digest', async () => {
  const requests = mockRequests({ 'POST /api/uploads': { url: '/files/1' } });
  const { root, settle } = await render(page, { actions, requests });
  const button = root.querySelector('button')!;
  expect(button.disabled).toBe(true);

  choose(root.querySelector('input')!, new File(['abc'], 'abc.txt'));
  await settle();
  expect(root.querySelector('code')!.textContent).toBe(DIGEST);
  expect(button.disabled).toBe(false);

  button.click();
  await settle();
  expect((requests.calls[0]!.body as FormData).get('sha256')).toBe(DIGEST);
  expect(root.querySelector('a')!.getAttribute('href')).toBe('/files/1');
});

test('a failed upload shows the server message', async () => {
  const requests = mockRequests({ 'POST /api/uploads': { status: 413, body: { message: 'File too large' } } });
  const { root, settle } = await render(page, { actions, requests });
  choose(root.querySelector('input')!, new File(['abc'], 'abc.txt'));
  await settle();
  root.querySelector('button')!.click();
  await settle();
  expect(root.querySelector('[role=alert]')!.textContent).toBe('File too large');
});

test('sinter check: arguments are checked against the actions', () => {
  const files = { 'src/sinter.actions.js': source };
  expect(checkPage(page, { files })).toEqual([]);
  const [d] = checkPage(page.replace('upload(file, digest)', 'upload(file)'), { files });
  expect([d!.code, d!.message]).toEqual(['SN208', expect.stringContaining("is not assignable to type '[file: File, digest: string]'")]);
});

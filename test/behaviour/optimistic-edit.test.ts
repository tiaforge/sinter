import { expect, test } from 'vitest';
import { render, mockRequests } from '../../src/testing/index.js';

const page = `<!doctype html><html><head></head><body>
<sn-resource name="items" src="/api/items" key="id" type="any"></sn-resource>
<ul data-sn-state="{ editingId: /** @type {number|null} */ (null), editTitle: '', failed: false }">
  <template data-sn-for="i in items" data-sn-key="i.id">
    <li>
      <template data-sn-if="editingId === i.id">
        <form data-sn-patch="/api/items/{i.id}" data-sn-body="{ title: editTitle }"
              data-sn-optimistic="patch(i, { title: editTitle })"
              data-sn-on-submit="editingId = null"
              data-sn-catch="failed = true">
          <input name="title" data-sn-model="editTitle"><button>Save</button>
        </form>
      </template>
      <template data-sn-else><span class="t" data-sn-text="i.title"></span>
        <button class="edit" type="button" data-sn-on-click="editingId = i.id; editTitle = i.title">Rename</button></template>
    </li>
  </template>
  <p class="f" data-sn-show="failed">failed</p>
</ul></body></html>`;

// An inline edit with an optimistic change leaves edit mode when it is sent, not in `then`: the form is gone
// at once, and the action still sends, rolls back and runs `catch` (a benchmark agent closed it in `then`, so the
// new title waited for the server).
async function rename(status: number) {
  const requests = mockRequests({ 'GET /api/items': [{ id: 1, title: 'Old' }], 'PATCH /api/items/1': status === 200 ? {} : { status } });
  const { root, flush, settle } = await render(page, { requests });
  await settle();
  (root.querySelector('.edit') as HTMLButtonElement).click();
  await flush();
  const input = root.querySelector('input')!;
  input.value = 'New';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  root.querySelector('form')!.requestSubmit();
  await flush();
  return { root, requests, settle };
}

test('the new title shows at once and the form is gone before the answer', async () => {
  const { root, requests, settle } = await rename(200);
  expect(root.querySelector('form')).toBeNull();
  expect(root.querySelector('.t')!.textContent).toBe('New');
  expect(requests.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { title: 'New' } });
  await settle();
  expect(root.querySelector('.t')!.textContent).toBe('New');
  expect((root.querySelector('.f') as HTMLElement).hidden).toBe(true);
});

test('a refused rename rolls back and runs catch after its form is gone', async () => {
  const { root, settle } = await rename(500);
  await settle();
  expect(root.querySelector('.t')!.textContent).toBe('Old');
  expect((root.querySelector('.f') as HTMLElement).hidden).toBe(false);
});

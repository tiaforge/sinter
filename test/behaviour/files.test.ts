// The `file:` source (docs/resources.md#files): a file of the project read at build time, a constant
// resource whose value reaches the browser as embedded data in the head, with no request.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { resolveApis } from '../../src/compiler/apis.js';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const files = {
  'post.txt': 'Hello <world> </script> ok',
  'data/tags.json': JSON.stringify({ tags: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }),
  'src/components/x-note.html': '<template data-sn-component="{}"><p><sn-resource name="note" src="file:./note.txt"></sn-resource><span data-sn-text="note"></span></p></template>',
  'src/components/note.txt': 'from the component folder',
};

/** compiles a page under /p with the files above (paths relative to /p) */
const build = (html: string, more: Record<string, string> = {}, o: Record<string, unknown> = {}) => compile(html, {
  file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, componentNames: ['x-note'],
  readFile: (f) => { const t = { ...files, ...more }[f.replace(/^\/p\//, '')]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
  ...o,
});
const errors = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

describe('a file: resource', () => {
  test('text and JSON (with items and key), a constant status, no request', async () => {
    const requests = mockRequests({});
    const r = await render(`<sn-resource name="post" src="file:./post.txt"></sn-resource>
      <sn-resource name="tags" src="file:/data/tags.json" items="tags" key="id"></sn-resource>
      <p data-sn-text="post"></p><ul><template data-sn-for="t in tags"><li data-sn-text="t.name"></li></template></ul>
      <i data-sn-text="[$meta.post.loading, $meta.post.error, $meta.post.loadedAt, $meta.tags.loading].join(',')"></i>`, { files, requests });
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('Hello <world> </script> ok');
    expect([...r.root.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['a', 'b']);
    expect(r.root.querySelector('i')!.textContent).toBe('false,,,false');
    expect(requests.calls).toEqual([]);
    // reloads when the page is shown again or the network returns: nothing for a file
    await r.window('online');
    await r.window('pageshow');
    await r.settle();
    expect(requests.calls).toEqual([]);
  });

  test('the value is embedded data in the head, early with the first paint; not in the embed manifest; a dependency of the page', async () => {
    const out = build(`<!doctype html><html><head></head><body><sn-resource name="post" src="file:./post.txt"></sn-resource><p data-sn-text="post"></p></body></html>`, {}, { embed: true });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<script type="application\/json" data-sn="\d+">"Hello \\u003cworld> \\u003c\/script> ok"<\/script>/);
    expect(out.embed).toEqual([]);
    expect(out.files).toContain('/p/post.txt');
    const { root } = await firstPaint(`<!doctype html><html><head></head><body><sn-resource name="post" src="file:./post.txt"></sn-resource><p data-sn-text="post"></p></body></html>`, { files });
    expect(root.querySelector('p')!.textContent).toBe('Hello <world> </script> ok');
  });

  test('a relative path resolves against the file that writes it: a component\'s, from its folder', async () => {
    const r = await render('<x-note></x-note>', { files, components: { 'x-note': files['src/components/x-note.html'] } });
    expect(r.root.querySelector('span')!.textContent).toBe('from the component folder');
  });

  test('SN332: an interpolation, outside the root, a missing file, broken JSON, items over text', () => {
    const one = (src: string, extra = '') => errors(build(`<sn-resource name="r" src="${src}"${extra}></sn-resource><p data-sn-text="r"></p>`, { 'bad.json': '{ nope' }));
    expect(one('file:./{x}.txt')).toEqual([expect.stringMatching(/^SN332 a `file:` path is a literal/)]);
    expect(one('file:../secret.txt')).toEqual([expect.stringMatching(/^SN332 `\.\.\/secret\.txt` is outside the project root/)]);
    expect(one('file:/../etc/passwd')).toEqual([expect.stringMatching(/^SN332 .* is outside the project root/)]);
    expect(one('file:./gone.txt')).toEqual([expect.stringMatching(/^SN332 `file:\.\/gone\.txt`: no such file in the project \(`gone\.txt`\)/)]);
    expect(one('file:./bad.json')).toEqual([expect.stringMatching(/^SN332 `bad\.json` is not valid JSON/)]);
    expect(one('file:./post.txt', ' items="x"')).toEqual([expect.stringMatching(/^SN332 `items` picks a list out of a JSON file/)]);
    expect(one('file:')).toEqual([expect.stringMatching(/^SN332 `file:` needs a path/)]);
  });

  test('SN332: what would load, page or change it', () => {
    for (const a of ['refresh="30s"', 'cache', 'paginate="offset" page-size="2"', 'when="true"', 'then="x = 1"', 'early="off"', 'order="name"', 'method="POST"']) {
      const e = errors(build(`<div data-sn-state="{ x: 0 }"><sn-resource name="r" src="file:./post.txt" ${a}></sn-resource><p data-sn-text="r"></p></div>`));
      expect(e.some((x) => x.startsWith(`SN332 \`${a.split('=')[0]}\``)), a).toBe(true);
    }
    const json = (body: string) => errors(build(`<sn-resource name="tags" src="file:/data/tags.json" items="tags" key="id"></sn-resource>${body}`));
    expect(json('<button data-sn-on-click="refresh(\'tags\')"></button><p data-sn-text="tags.length"></p>')).toEqual([expect.stringMatching(/^SN332 `refresh\(\)` would load or change `tags`/)]);
    expect(json('<button data-sn-on-click="upsert(\'tags\', { id: 3 })"></button><p data-sn-text="tags.length"></p>')).toEqual([expect.stringMatching(/^SN332 `upsert\(\)`/)]);
    expect(json('<template data-sn-for="t in tags"><button data-sn-on-click="remove(t)"></button></template>')).toEqual([expect.stringMatching(/^SN332 `remove\(\)` (would load or )?changes? `tags`, a `file:` resource/)]);
    expect(json('<sn-sync src="/s"><sn-event name="added" resource="tags" op="upsert"></sn-event></sn-sync><p data-sn-text="tags.length"></p>')).toEqual([expect.stringMatching(/^SN332 an `<sn-event>` changes `tags`/)]);
  });

  test('SN332: file: is a resource\'s source only, not an action\'s or a stream\'s', () => {
    expect(errors(build('<button data-sn-post="file:./post.txt"></button>'))).toEqual([expect.stringMatching(/^SN332 `file:` is a source for `<sn-resource src>`.*An action sends a request/)]);
    expect(errors(build('<sn-resource name="r" src="/api/r"></sn-resource><sn-sync src="file:./s"><sn-event name="x" resource="r" op="refetch"></sn-event></sn-sync><p data-sn-text="r"></p>'))).toEqual([expect.stringMatching(/^SN332 .*A stream sends a request/)]);
  });

  test('with sinter({ apis }): file: is read as a file, and `file` is a reserved API name (SN329)', async () => {
    const r = await render('<sn-resource name="post" src="file:./post.txt"></sn-resource><p data-sn-text="post"></p>', { files, apis: { main: { base: '/api' } } });
    expect(r.root.querySelector('p')!.textContent).toBe('Hello <world> </script> ok');
    const bad = resolveApis({ apis: { file: { base: '/files' } } }, () => null, [], 'vite.config.ts');
    expect(bad.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([expect.stringMatching(/^SN329 sinter\(\{ apis \}\): `file` is the built-in source of the project's own files/)]);
  });
});

// @vitest-environment node
// packages/create: `npm create @tiaforge-ui` copies the template; its demo API answers as the
// pages expect; the template builds with both checkers on and fails on the typos its README names.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sinter from '../src/vite.js';

const repo = resolve(import.meta.dirname, '..');
const bin = join(repo, 'packages/create/index.js');
const tmp = mkdtempSync(join(tmpdir(), 'sinter-create-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Runs the scaffolder in `tmp`. */
const create = (...args: string[]) => execFileSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env: { ...process.env, npm_config_user_agent: 'npm/11' } });

test('copies the template, restores .gitignore and names the package after the directory', () => {
  const out = create('My App');
  const dir = join(tmp, 'My App');
  expect(readdirSync(dir).sort()).toEqual(['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'index.html', 'package.json', 'server', 'src', 'task.html', 'tsconfig.json', 'vite.config.js']);
  expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name).toBe('my-app');
  expect(out).toContain('cd "My App"\n  npm install\n  npm run dev');
  expect(() => create('My App')).toThrow();
});

test('the template asks for the version of sinter this repo is at', () => {
  const pkg = (p: string) => JSON.parse(readFileSync(join(repo, p), 'utf8'));
  const { version } = pkg('package.json');
  expect(pkg('packages/create/package.json').version).toBe(version);
  // a scoped package is published private unless it says otherwise
  expect(pkg('packages/create/package.json').publishConfig).toEqual({ access: 'public' });
  expect(pkg('packages/create/template/package.json').dependencies['@tiaforge-ui/sinter']).toBe(`^${version}`);
});

describe('the demo API', () => {
  let server: ViteDevServer;
  let base: string;
  beforeAll(async () => {
    const { default: api } = await import(join(repo, 'packages/create/template/server/api.js'));
    server = await createServer({ configFile: false, root: tmp, logLevel: 'silent', plugins: [api()], server: { port: 0 } });
    await server.listen();
    base = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
  });
  afterAll(() => server?.close());

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  test('creates, changes and deletes tasks, and streams each change', async () => {
    const events: string[] = [];
    const stream = new AbortController();
    const reading = fetch(base + '/api/events', { signal: stream.signal }).then(async (res) => {
      const decoder = new TextDecoder();
      for await (const chunk of res.body!) events.push(decoder.decode(chunk));
    }).catch(() => {});

    const all = await call('GET', '/api/tasks');
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThan(0);

    const created = await call('POST', '/api/tasks', { title: '  Ship it ' });
    expect(created).toMatchObject({ status: 201, body: { title: 'Ship it', done: false, notes: '' } });
    const id = created.body.id;
    expect(await call('PATCH', `/api/tasks/${id}`, { done: true, notes: 'n' })).toMatchObject({ status: 200, body: { id, done: true, notes: 'n' } });
    expect(await call('POST', '/api/tasks', { title: ' ' })).toMatchObject({ status: 422 });
    expect(await call('DELETE', `/api/tasks/${id}`)).toEqual({ status: 204, body: null });
    expect(await call('GET', `/api/tasks/${id}`)).toMatchObject({ status: 404 });

    await new Promise((r) => setTimeout(r, 50));
    stream.abort();
    await reading;
    const text = events.join('');
    expect(text).toContain(`event: task_updated\ndata: {"task":{"id":"${id}","title":"Ship it"`);
    expect(text).toContain(`event: task_removed\ndata: {"id":"${id}"}`);
  });

  test('"fail next change": the next change is refused, reads are not, and only once', async () => {
    const [first] = (await call('GET', '/api/tasks')).body;
    expect((await call('POST', '/api/fail-next')).status).toBe(204);
    expect((await call('GET', '/api/tasks')).status).toBe(200);
    expect(await call('PATCH', `/api/tasks/${first.id}`, { done: !first.done })).toMatchObject({ status: 503, body: { message: expect.any(String) } });
    expect((await call('PATCH', `/api/tasks/${first.id}`, { done: !first.done })).status).toBe(200);
  });
});

// temper is a devDependency of the repo, for this build
const temperDir = join(repo, 'node_modules/@tiaforge-ui/temper');

describe('the template builds', () => {
  const dir = join(tmp, 'built');
  const src = resolve(repo, 'src');
  const alias = [
    { find: /^@tiaforge-ui\/sinter\/([\w-]+)$/, replacement: `${src}/$1.ts` },
    { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` },
  ];

  beforeAll(() => {
    create('built');
    const modules = join(dir, 'node_modules');
    mkdirSync(join(modules, '@tiaforge-ui'), { recursive: true });
    symlinkSync(temperDir, join(modules, '@tiaforge-ui/temper'));
    symlinkSync(repo, join(modules, '@tiaforge-ui/sinter'));
    symlinkSync(join(repo, 'node_modules/typescript'), join(modules, 'typescript'));
  });

  const run = async (edit?: [string, string]) => {
    const page = join(dir, 'index.html');
    const original = readFileSync(page, 'utf8');
    if (edit) {
      expect(original).toContain(edit[0]);
      writeFileSync(page, original.replace(edit[0], edit[1]));
    }
    try {
      const { default: temper } = await import(join(temperDir, 'lib/vite.js'));
      const { default: api } = await import(join(dir, 'server/api.js'));
      const input = { index: join(dir, 'index.html'), task: join(dir, 'task.html') };
      await build({
        configFile: false, root: dir, logLevel: 'silent', appType: 'mpa',
        plugins: [sinter({ typecheck: true }), temper(), api()],
        resolve: { alias },
        build: { outDir: join(dir, 'dist'), emptyOutDir: true, rollupOptions: { input } },
      });
    } finally {
      writeFileSync(page, original);
    }
  };

  test('with both checkers on', async () => {
    await run();
    // task.html is a directory's index (task/index.html at /task/); task.html redirects there
    expect(readdirSync(join(dir, 'dist')).sort()).toEqual(['assets', 'index.html', 'task', 'task.html']);
  }, 60_000);

  test.each([
    ['t.title', 't.titel', /SN208[^\n]*Property 'titel' does not exist on type 'Task'. Did you mean 'title'\?/],
    ['visible(tasks, q, show)', 'visible(tasks, qq, show)', /SN201[^\n]*`qq` is not defined here. Did you mean `q`\?/],
    ['data-icon="trash-2" data-variant="ghost"', 'data-icon="trash-2" data-variant="danger"', /TM101 data-variant="danger" is not valid. Did you mean data-tone="danger"\?/],
  ])('the README\'s typo %s → %s fails the build', async (from, to, message) => {
    await expect(run([from, to])).rejects.toThrow(message);
  }, 60_000);
});

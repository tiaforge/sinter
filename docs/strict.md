# Strict mode

Strict mode makes warnings fail, everywhere sinter reports them: `sinter check`, `vite build`, the
dev server and `render()` in tests. It is meant for CI and for coding agents. An agent reads a build
that passes as "no mistakes", and does not look at warnings scrolled past in the log; when they fail
the build, it fixes them, or says why a code should stay a warning.

```js
// vite.config.js
sinter({ strict: true })
```

`SINTER_STRICT=1` turns it on without changing the config, and `SINTER_STRICT=0` turns it off. Set
it where the agent or the CI job runs, so the config cannot quietly opt out.

## What fails

| Where | In strict mode |
| --- | --- |
| `sinter check` | a page's warnings are printed as errors, exit code 1 (`--strict`, `--no-strict` and `--allow SN504,SN517` for one run) |
| `vite build` | a page's warnings fail it as its errors do; the build's own warnings (`SN519` and up: an unused preload, a link through a redirect, missing translations, the early budget, …) fail it once it has run, all of them listed |
| dev server | a page's warnings fail the page in Vite's overlay, as its errors do; the runtime's warnings in the browser (a duplicate key, an item without its key field, state changed outside sinter, a binding that threw, …) are printed in the terminal and shown in the overlay |
| `render()` | a page's warnings throw as its errors do; a runtime warning makes the call that ran it reject (`render`, `flush`, `settle`, `advance`, `frame`, `back`, …) |

A promoted warning keeps its code, and its hint says how to keep it a warning:

```text
index.html:3:1 error SN501 unused-resource: resource `addressbooks` is declared but never read
  hint: a warning, an error with --strict (`--allow SN501` keeps it a warning)
```

## What stays a warning

- Warnings that depend on the machine or the network, not on the project: `SN524` (sharp not
  installed), `SN525` (a font that could not be downloaded), `SN526` (a stylesheet the CSS tools
  could not compile), `SN527` (an image the API did not serve). A strict build would otherwise pass
  or fail with the network.
- `SN507` (`complex-expression`), which is a measure rather than a mistake. Failing on it pushes code
  into odd shapes to get under a limit. `sinter({ complexity: { level: 'error' } })` makes it an error
  when you want that.
- Runtime warnings that depend on the server, the browser or timing: a stream over HTTP/1.1, a
  response over the cache limit, a CSP header blocking the Speculation Rules, a preloaded font the
  first frames did not use, the browser refusing a history write. The dev server prints them;
  `warnings()` in tests has them.

## Keeping a code a warning

`allow` names the codes that stay warnings, each with the reason, so the exception is visible in
review:

```js
sinter({
  strict: {
    allow: {
      SN504: 'the legacy API has no types yet',
      SN517: 'the audit log is read-only',
    },
  },
})
```

An unknown code, or a code without a reason, is refused when the config loads. `sinter check`
reads `allow` from the Vite config; `--allow` adds codes for one run.

## In tests

`render(html, { strict: true })`, or `SINTER_STRICT=1`, turns it on for tests;
`render(html, { strict: { allow: { … } } })` takes the same `allow`. A test about a warning passes
`strict: false`, which wins over the environment variable, and reads `warnings()`:

```js
const r = await render(page, { strict: false });
r.root.querySelector('button').click();
await r.flush();
expect(r.warnings().map((w) => w.message)).toContain('sinter: duplicate key in `data-sn-for`: 3');
```

`warnings()` lists the runtime's warnings and errors since `render()`, in or out of strict mode:
`{ code, message, error, environment }`.

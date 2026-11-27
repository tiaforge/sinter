# Page loads on a real network path

How long a built page takes to paint when the bandwidth is limited on the network path, not inside the browser, and a
real server (nginx) decides which bytes go out first. Use it for any question about load order: which request waits for
which, whether a preload or a reordered `<head>` helps, HTTP/2 against HTTP/1.1.

The browser (Node + Playwright's Chromium) runs in a network namespace; nginx and the app's backend run outside it. The
two are joined by a veth pair whose host side carries an `htb` bandwidth limit towards the browser. The round trip is
added by the kernel where it has `netem`, else by Chromium per request (see [what this machine can do](#what-a-machine-can-and-cannot-do)).

## Requirements

- Linux, root (CAP_NET_ADMIN): network namespaces and `tc`.
- `iproute2` and `nginx`, installed by you (`apt-get install -y iproute2 nginx`); `openssl`. The scripts install nothing.
- Node 22+, this repository's `npm ci`, and Playwright's Chromium (`npx playwright install chromium`).
- Nothing else of the machine is shaped: not `lo`, which other work and the browser's control channel use.
- `realnet.sh down` always cleans up (namespace, veth pair, qdiscs) and is safe to run any time; `nginx.sh stop` the same.

## Files

| file | what |
| --- | --- |
| `realnet.sh` | `check` (what the kernel offers), `up [rate] [delay]`, `exec <command…>` (inside the namespace), `down` |
| `nginx.sh`, `nginx.conf.tmpl` | `start <static dir> [backend host:port] [tuned]`, `stop`: HTTP/2 on :8443 and HTTP/1.1 on :8444 of the host address, TLS with a self-signed certificate, files of the build served by nginx, everything else proxied to the backend |
| `timeline.mjs` | loads a URL N times, cold: first paint, largest paint, when an element first exists (`--data`), performance marks, and per request: start, first byte, last byte, protocol, priority, server address |
| `summary.mjs` | medians [min-max] per label of a `timeline.mjs` JSON-lines file, and the protocols seen |
| `example-realworld.sh` | the worked example, end to end |

Addresses: host side `10.77.0.1`, namespace `10.77.0.2` (`REALNET_NET=10.77.0`); namespace `sn-realnet`
(`REALNET_NS`); nginx ports `REALNET_H2=8443`, `REALNET_H1=8444` on the host address only, so they clash with nothing
on the machine's other addresses; state (certificate, config, logs) in `REALNET_STATE` (default `$TMPDIR/sinter-realnet`).

## A number in minutes: the worked example

```sh
sudo bench/realnet/realnet.sh check            # namespaces, htb, netem, tbf, fq: yes/no
sudo bench/realnet/example-realworld.sh 4      # RealWorld home, HTTP/2 vs HTTP/1.1, 4 interleaved rounds
sudo bench/realnet/example-realworld.sh 4 tuned
```

It builds `examples/realworld` if it has no `dist/`, starts `bench/realworld`'s mock API (plain HTTP on the loopback),
brings the path up at 1.6 Mbit/s, starts nginx with the build as static files and the mock API as backend, and loads
the home page inside the namespace with a 150 ms round trip in the browser and 4x CPU. The page's API host
(`api.realworld.show`) is resolved to nginx (`--host-map`), so the data goes through the shaped path too. Output: a
table per label; the loads are in `$REALNET_STATE/realworld.jsonl` (per request: protocol, priority, server).

### Your own page

```sh
sudo bench/realnet/realnet.sh up 1600kbit
sudo bench/realnet/nginx.sh start path/to/dist 127.0.0.1:3000          # your backend; add `tuned` for the variant
sudo bench/realnet/realnet.sh exec node bench/realnet/timeline.mjs https://10.77.0.1:8443/some/page \
  --runs 1 --rtt 150 --data '.row' --label A --json loads.jsonl --requests
# … the variant, then the baseline again, alternating …
node bench/realnet/summary.mjs loads.jsonl
sudo bench/realnet/nginx.sh stop; sudo bench/realnet/realnet.sh down
```

A page behind a sign-in: `--before signin.mjs`, a module run once in the browser context before the loads (its cookies
are kept). For example, a demo button on the start page:

```js
// signin.mjs
export default async ({ context, origin }) => {
  const page = await context.newPage();
  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  await page.locator('button[type=submit]').first().click();
  await page.waitForLoadState('networkidle');
  await page.close();
};
```

Your own marks (`performance.mark('app:mounted')`) are recorded with `--marks app:` (all marks by default).

## What went wrong before this existed

These are the traps one day of measuring (2026-11-27, Caley and RealWorld) fell into. Each produced a number that looked
fine and was wrong.

1. **DevTools throttling is inside the browser.** `Network.emulateNetworkConditions` with a bandwidth limit lets the
   server send everything at loopback speed and then meters the bytes out inside Chromium. Nothing about the server's
   ordering survives that, and Chromium's own scheduler honours request priority in a way most servers do not. It
   produced a false gain (a `fetchpriority="low"` preload: −64 ms largest paint emulated, nothing on nginx) and hid a
   real one (stylesheets asked for before the modules: −550 ms first paint on nginx, invisible under emulation, where
   first paint over HTTP/2 looked 350 ms worse for another reason). Limit bandwidth on the network path. `timeline.mjs`
   offers DevTools bandwidth (`--devtools-kbps`) only for comparison with old numbers.
2. **A Firecracker kernel has no `netem`.** On the cloud VMs this was built on (kernel `6.18.x-fc`, no loadable
   modules: no `modprobe`, no `/lib/modules`), `tc` knows `htb`, `tbf` and `pfifo` but not `netem`, `fq`, `fq_codel`,
   `sfq`, `prio` or `cake`. So the path can limit bandwidth but add no delay. `realnet.sh check` tells you; with `netem`,
   `realnet.sh up 1600kbit 75ms` adds 75 ms each way in the kernel and you leave `--rtt` at 0. Without it, `--rtt 150`
   adds the round trip per request in Chromium (latency only, no bandwidth). What that means: requests do not queue
   behind each other's round trips as on a real path (each is delayed on its own; over one HTTP/2 connection the
   delays overlap), there is no handshake round trip, no TCP slow start, no loss. Absolute times are optimistic;
   comparisons within one setup are fair; the order in which the server sends is real, because the bandwidth limit is.
3. **nginx with default settings writes far ahead.** Watch the server's send queue while a page loads:
   `watch -n0.1 "ss -tmn state established '( sport = :8443 )'"` (the `Send-Q` column, `skmem` `tb`). With nginx 1.24's
   defaults the HTTP/2 connection held up to 300 KB (mean 62 KB): the kernel autotunes the send buffer, nginx fills it
   with what was asked first (the modules), and the stylesheet asked for a moment later goes out after all of it. So a
   default nginx sends in request order, whatever the priorities. `nginx.sh start … tuned` (`sndbuf=16k`,
   `http2_chunk_size 4k`) keeps the queue under ~50 KB, and nginx then interleaves by priority: the stylesheet arrived at
   511 ms instead of 951. Measure both: the default is what most deployments run; the tuned one shows what a
   priority-aware server does, and which of your effects depend on the server.
4. **Playwright's Chromium inherits proxy variables.** In an environment with `HTTPS_PROXY`, Chromium sends the
   requests for a mocked host (`--host-resolver-rules`) through the proxy to the real internet: a day's RealWorld
   numbers measured the public API. Tell by the server address CDP reports for the API requests (`server` in
   `timeline.mjs`'s output: it must be your mock or nginx, not the proxy's port). `timeline.mjs` launches Chromium with
   the proxy variables removed and `--no-proxy-server`.
5. **No warm cache under a certificate error.** Chromium does not store responses in its HTTP cache when the
   certificate is not trusted, so with the self-signed certificate every load is cold, "warm" or not (a warm run here
   re-downloaded every script). `timeline.mjs` clears the cache before each load to make that explicit. If a repeat
   view matters, trust the certificate in the browser's profile (an NSS database with `certutil`, or a CA Chromium
   trusts) and drop `--ignore-certificate-errors`, or measure the repeat view over HTTP/1.1 without TLS.
6. **Method.**
   - Interleave baseline and variant (A, B, B, A, …), one load each per round. 4 rounds are enough to decide: an
     effect that needs more rounds to see is not worth building.
   - Report medians with the range [min-max]. A difference inside the ranges is no measurable difference.
   - A structural question ("does request X wait for Y?") needs one load's per-request table (`--requests`), not a
     matrix of runs.
   - Check the protocol of every load (`nextHopProtocol`; `summary.mjs` lists it): a fallback to HTTP/1.1 is silent.
   - Run one benchmark at a time on the machine, and nothing heavy beside it (builds, test suites).
   - Next to every number, say what was emulated and what was real (bandwidth on the path, round trip in the browser,
     CPU slowdown).

## Reference results (2026-11-27)

nginx 1.24.0 with its defaults, 1.6 Mbit/s on the path (htb), 150 ms round trip in the browser, 4x CPU, cold cache,
medians of 4 interleaved rounds (8 for "as built"), ms. Caley's mail and calendar pages, built with sinter at the
commits of that day.

| page | case | first paint | largest paint |
| --- | --- | ---: | ---: |
| mail | HTTP/1.1, as built | 952 [796–984] | 2,020 [1,576–2,076] |
| mail | HTTP/2, as built (stylesheets after the modules) | 1,136 [868–1,200] | 2,020 [1,936–2,084] |
| mail | HTTP/2, stylesheets before the modules | 588 [568–628] | 2,016 [1,992–2,060] |
| mail | HTTP/2, as built, nginx `tuned` | 648 [612–676] | 2,224 [2,148–2,260] |
| calendar | HTTP/1.1, as built | 712 [672–744] | 1,280 [1,168–1,284] |
| calendar | HTTP/2, as built | 808 [748–988] | 1,024 [992–1,072] |
| calendar | HTTP/2, stylesheets before the modules | 548 [500–560] | 1,028 [892–1,048] |

The main stylesheet's first byte, HTTP/2, default nginx: 800–970 ms as built, 330 ms with the stylesheets first.
The stylesheet order is what sinter builds since 2026-11-27 (docs/first-paint.md, "The stylesheets are asked for
first"). RealWorld's home page in the worked example: first paint about 700 ms over both protocols (1 round, as a check
that the setup works, not a reference).

## Left out

An HTTP/2 front written in Node (proxying to a plain-HTTP server) was used before nginx: it is quick to start but
ignores priorities and buffers whole responses, so it shows neither a default server's behaviour nor a tuned one's.
nginx replaces it. h2o, a server known for strict priority handling, was not set up.

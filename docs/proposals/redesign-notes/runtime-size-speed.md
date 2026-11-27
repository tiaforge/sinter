# Runtime size and page-load speed: what was measured, shipped and dropped

Running log (2026-11-27). Question asked: sinter interprets a compiled IR; is there a technique, up to a large
rewrite, that shrinks the delivered JavaScript and makes pages faster? Answer after a day of spikes: no rewrite
pays. The IR design is sound; the wins were small, specific changes, and the largest one was not in the runtime at
all (the order of two kinds of tag in the built head). Base `162d0a7`, end `4fb4c57` (pull requests #128–#142).

Test pages: the RealWorld example (`examples/realworld`, a small site) and Caley, a real mail, calendar and contacts
app built with sinter and its mail components (7 pages, 213 templates on the mail page; not in this repository).
**Measured** marks a number from a run; **estimate** marks one derived from other numbers. The spikes' prototypes and
raw data lived in the session's scratchpad and local branches and were not committed, unless a section says so.
Network measurements: read [bench/realnet/README.md](../../../bench/realnet/README.md) first; half of the first
network numbers of the day were artifacts of the browser's own throttling (§5).

## 1. Where the time and the bytes are

Caley's mail page, load, 4x CPU throttle, localhost (measured, one profile plus 7 runs of the phases):

- Main thread busy about 750–880 ms before the app's own idle work. All of sinter (head scripts, mount, loaders,
  store, feature modules): about 160–190 ms, 20%. The binding layer alone (finding elements, evaluating, writing):
  50–66 ms, 6–9%. That is the ceiling for a faster binding layer. The rest is the browser (style 112, layout 61,
  paint 53, HTML parse 67) and the app (its mail parser's warm-up, date formatters, a layout-forcing island).
- Mount 80–99 ms: starting the loaders 17–30, first walk 35–42. Flushes after data 70–99. Running the page module
  itself: about 12 ms.
- Interactions: opening a message, script 80–92 ms; two calendar "next" clicks, flush 95–102 ms.

Bytes, mail page at the start of the day: all static JS 418,576 B min / 108,758 gzip, of which the page module 60%,
the app's own code 19%, sinter's feature modules 10%, the core 10%. The page module: IR 130 KB (templates 82),
expression functions 76 KB (914 of them); the dependency and write lists were 70 KB of the IR. RealWorld's home is
the opposite: 36.9 KB gzip, of which the page module 2.8 and the runtime nearly everything.

RealWorld home against a client-side Solid RealWorld (`solidjs/solid-realworld`, 12 KB gzip; it fails the suite's
routing): of the 25 KB gap, about 13.6 are features that app does not have (early first paint 5.4, prefetch, swaps,
view transitions, cache and Back, optimistic updates), 9–10 the same feature costing more, of which about 7 is
capability one would keep and under 0.3 plain slack, and about 2 was unreachable code (now flagged out). Details in
[realworld-comparison.md](../../realworld-comparison.md).

## 2. Shipped

| PR | Change | Measured effect |
| --- | --- | --- |
| #128 | A dead branch the minifier kept in `walk()` | minimal page 11,195 → 10,246 B gzip |
| #129 | `pruneWrites`: a write list drops what an `X.**` of the same list covers | mail page module 213,941 → 176,482 min, 30,521 → 28,769 gzip; no change in what is marked |
| #131 | A stale-page bug: a member of a helper's result lost its `**` pieces | correctness |
| #132, #133 | V8 compile hint on the chunk holding the core, and on line 1 (Vite pushed it to line 2, where V8 ignores it) | main-thread compile on a cold load: mail 116 → 82 ms, calendar 60 → 30; calendar largest paint 418 → 386 ms (10 paired rounds, localhost) |
| #135 | Finer build flags: store-function groups, writers, keyed/ordered stores, moves, APIs | minimal page 10,246 → 8,565 B gzip; core without parts 6,229 → 5,272; RealWorld home 36,888 → 36,081 |
| #136 | `explainWrites`: `SN548` says why a handler marks everything | diagnostic |
| #137 | Write prover: aliases are followed where the build can prove what they hold (lets, loop items, callback parameters, DOM events, event senders, component scripts); dev builds check every write (warning 36) | handlers marking "everything" on Caley's six pages 143/70/33/22/38/29 → 0 (with two one-line app changes); evaluations: open a message 910 → 304, calendar next ×2 1,532 → 1,210; mail page module 176,482 → 155,875 min, gzip unchanged |
| #139 | Helpers are pure everywhere: a helper changes none of its arguments. Build error `SN214` for writes the build can see, dev warning 37 for the rest | removes a stale-row bug (`bump(ys[0])`); no real code depended on the old rule |
| #140 | `SN205` also for a write through state that holds a resource's data (`sel = row; sel.n = 9`) | in production it changed the resource's cached object silently |
| #141 | Early requests stay on when request middleware only reads the response (decided from the config module's syntax tree, no API change) | real network, HTTP/2: largest paint mail 2,020 → 1,944 ms, calendar 1,024 → 980, at the edge of the spread; first row 41 and 84 ms sooner |
| #141 | `data-sn-preload` links have `fetchpriority="low"` | none on a real server (§5); harmless |
| #142 | Built pages ask for their stylesheets before the page script and its module preloads | real network, default nginx, HTTP/2: first paint mail 1,136 → 588 ms, calendar 808 → 548; nothing else later |
| #142 | Early files leave out bindings that can never paint early | Caley's early scripts, gzip: mail 10,333 → 7,753 B, settings 6,494 → 4,494 |

Before and after on Caley as a whole, 4x CPU, localhost, interleaved (measured): interactions no measurable
difference (calendar next ×2 script 76 → 67 ms, ranges 56–136 and 44–96); calendar load largest paint 456 → 408 ms;
mail load none. So the day's runtime changes are visible in bytes and in first paint on a slow link, not in
interaction time.

## 3. Measured and dropped

Each of these was prototyped far enough to measure. Do not rebuild one without a new reason.

- **Bindings compiled to code instead of interpreted IR.** Page modules get smaller minified and larger compressed
  (mail −7.6% min, +12.6% gzip: code compresses worse than JSON with repeated keys; only 316 of mail's 775 bindings
  are value bindings that become code). Mount on an app-shaped page 40 → 90 ms (V8 lazily compiling one large
  function with a `try` per binding). List benchmark unchanged. No.
- **A first-render part and a late interaction part.** Mail's first part −37% gzip, but no load metric moved,
  interactivity came 350 ms later (events queued and replayed), total bytes per visit +8%. No.
- **Dialogs loaded when first opened.** Page module + HTML −29 to −34% gzip on Caley's pages, which is 5–13% of what
  a page loads. No load metric moved on HTTP/1.1 or HTTP/2 (largest paint 1,804 vs 1,804 ms); the first open of a
  dialog 147 → 363 ms on a slow link unless prefetched, which downloads the bytes anyway. One chunk for all dialogs
  is larger than the saving. No.
- **Compact IR encoding** (positional tuples, string tables, path table). Mail page module −42% min, −11% gzip, but a
  decoder of 0.8 KB gzip in every site's core and 15 ms of decoding on mail. The exact part of it, pruning the write
  lists, shipped as #129. The rest: no.
- **Property mangling in the runtime.** 0.6–1.3% gzip, a permanent name table, and one silent bug in the trial. No.
- **Reading helper bodies for what a result shares with its arguments** (a points-to analysis over the helpers
  module, PR #138, closed). It halved calendar's evaluations (1,210 → 542) and that was not measurable in time
  (91 vs 80 ms, spread 40–55). Two independent reviews with an exact oracle found 9 and then 15 classes of helper
  for which the summary was too narrow (aliasing between locals, reordered arrays, unread call arguments, `var`,
  module state, shadowed built-ins). The reviewer's 186 probes and oracle are worth more than the analysis was.
- **Rules instead of analysis** (there are no outside users yet). "A helper returns new values": touches 29 sites on
  Caley in its strict form and makes page code worse. "State is a tree" (no mutable object at two places): needs no
  rewrite in Caley, its mail components or the examples, and would delete about 770 lines of alias analysis, but
  production would trust it where today's compiler proves or over-marks; a build-enforced form still needs the
  tracing and saves about 200 lines while asking apps for redundant copies. Stopped at what is merged.
- **Inlining the early scripts into the HTML.** They run 600 ms sooner and first paint does not move: it waits for
  the stylesheet. Costs HTML on every view and breaks under a `script-src 'self'` policy. No.
- **Every modulepreload at low priority.** First paint much better, but mount later (calendar largest paint +160 ms
  on a real server). The stylesheet order of #142 gets a better first paint without that cost.
- **`fetchpriority="high"` on stylesheets and early scripts.** Changes no priority Chrome assigns (stylesheets are
  already highest, parser-blocking scripts high). No effect.

Not shipped, but not refuted:

- **Preload links without the early script** (`firstPaint: false` builds emit none today, though a link needs no
  script). On RealWorld the tag list is in the DOM 137–153 ms sooner on a slow link; largest paint does not move
  because it is the banner there. A few lines in the build; the prototype was not kept.

## 4. Open, with what is known

Evaluations. A handler's write list says what it may have changed; everything reading that is evaluated again.
Calendar next ×2 on Caley: 1,210 evaluations for 247 DOM writes. In a precise prototype the 542 that remained were:
363 for the 192 rows that are new, about 100 structural checks after data arrived, 79 evaluated to the same value.
So the floor is about 460. Three separate gaps:

1. Write lists that say "anything below X" because a helper's result may share its arguments' objects (668 of the
   1,210; about 50 on mail). Cheapest sound route: rely on declared primitive types and check them at run time (a
   string cannot share an object); a prototype trusting types without the guard reached 542. Estimate: 200 lines,
   5 B per guarded call.
2. A computed list (`contacts.filter(…)`) forces all its rows on every re-evaluation, because its rows have no path
   to watch: typing in Caley's contacts filter evaluates 583 bindings for 0 writes. Needs the compiler to mark which
   inputs can change the elements and which only select among them. Not prototyped.
3. Same-value evaluations: a per-row test such as `iso === focusDate` runs for every row; a resource that returns
   equal data re-runs its readers.

None of this is visible in time on Caley (evaluations are cheap; rows, DOM work and app helpers are not), and exact
lists would save under 0.5 KB gzip per page module. Worth doing as "no wasted work", not for speed or size.

First paint with data:

- Mail's rows wait for a second request (`for` resources over embedded data, here the mailboxes of each account, are
  never requested early). The early script has the embedded accounts and could build those URLs.
- The early script never renders from a response. Rendering mail's rows when the early response arrives (about
  400 ms before mount ends on a slow link) is an estimate of one to two weeks: the early runtime would have to shape
  data as the loader does, and rows would be visible before their handlers exist. The cheap route to the same frame
  is the server embedding the first page, which needs that resource's URL to come from the page URL alone.

Early-script bytes still there: the head carries the page's whole runtime message dictionary (mail: 90 keys,
1.3 KB gzip) where the early file reads 8; closed popovers and unreferenced model setters (under 0.3 KB gzip a
page). Reusing the early file's expressions in the page module would save about 1 KB gzip but breaks on swaps,
which run no head script.

Runtime bytes: flags for the remaining unreachable code (call/POST/embedded resources, wrapper and text-run
templates, choice, action retry and confirm): about 0.6 KB gzip on RealWorld (estimate). The floor for RealWorld's
home with every feature on is about 35.5 KB gzip (estimate); without swaps, prefetch and early paint it is 27.

Servers: nginx's defaults write up to 300 KB ahead into an HTTP/2 connection, so responses go out in request order
whatever their priority. #142 makes the request order right. A deployment note on small send buffers (`sndbuf`,
`http2_chunk_size`) would help further (first paint 648 ms on mail as built, 580 with #142), with a possible cost on
largest paint that one run suggested and nothing confirmed.

## 5. What went wrong in measuring, so it does not happen again

1. Evaluation counts were optimized for half a day before anyone timed them. Halving them is not measurable.
   Measure the headline in milliseconds or bytes over the wire before building, and stop when it is weak.
2. Chrome's DevTools bandwidth throttling works inside the browser, after the server has sent everything at
   loopback speed, and it honours request priority in a way servers do not. It produced a gain that does not exist
   (the low-priority preload) and hid the largest real one (stylesheet order). Limit bandwidth on the network path
   (`bench/realnet`).
3. A test front that proxies HTTP/2 streams independently ignores priorities; conclusions about HTTP/2 from it were
   half wrong. Use a real server and look at its send queue.
4. Playwright's Chromium inherits proxy variables: requests to a mocked API host went to the real internet, and one
   reported result was that latency. Launch the browser without them and check the server address in the log.
5. Chrome does not cache responses under a certificate error, so a self-signed setup has no warm-cache runs.
6. Minified size and transferred size move differently: the write lists were a third of a page module minified and
   almost nothing compressed. Report both.
7. Benchmarks were over-specified twice (pages × profiles × caches × 7 rounds). Four interleaved rounds on one page
   decide; a structural question ("does request X wait for Y") needs one trace.

## 6. Rules that held up

- An analysis is an allow-list: it proves the cases it understands and falls back to the conservative answer,
  which must be the safe one (mark more, keep the binding, send the request again). The helper-body analysis failed
  where it modelled what its author thought of and let the rest through.
- Enforcement in layers, strongest first: a build error where the build can see it, an exact check in dev builds
  (warnings 36 and 37 are also usable as test oracles), and a stated gap for what production trusts.
- When something the framework allows makes a proof hard and nothing real depends on it, change the rule (pure
  helpers) before building the analysis. Check real code first: Caley, its components and the examples.
- For a soundness-critical change, an independent reviewer whose only job is to break it, with an oracle that runs
  the code, before it merges.

// A playing <audio> and <video> in a kept element, named for a same-document view transition (as a swap
// names kept elements, `sn-keep`) and moved into a new body inside the transition's update: do they play
// on, and is the transition still run? (docs/proposals/swap-navigation.md §8, step 5's probe)
//   node kept-media.cjs
const pw = require('../../../node_modules/playwright');
const { createServer } = require('node:http');
const rate = 8000, n = rate * 6, wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin(i / 10) * 3000), 44 + i * 2);
const PAGE = `<!doctype html><main><p>old page</p></main>
<aside id=keep><audio id=a src="/t.wav" controls></audio><video id=v muted width=160 height=90></video></aside><button id=b>b</button>`;
const srv = createServer((req, res) => {
  if (req.url === '/t.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wav); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
});
srv.listen(0, async () => {
  for (const w of ['chromium', 'firefox', 'webkit']) {
    let b;
    try { b = await pw[w].launch(w === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : w === 'firefox' ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } } : {}); } catch { console.log(w, 'skipped'); continue; }
    const p = await b.newPage();
    await p.goto('http://127.0.0.1:' + srv.address().port + '/');
    // the video plays a canvas stream (no media file needed)
    await p.evaluate(() => document.getElementById('b').addEventListener('click', () => {
      const c = Object.assign(document.createElement('canvas'), { width: 160, height: 90 }), x = c.getContext('2d');
      let f = 0;
      setInterval(() => { x.fillStyle = `hsl(${f++ * 7} 80% 50%)`; x.fillRect(0, 0, 160, 90); }, 30);
      const v = document.getElementById('v');
      v.srcObject = c.captureStream(30);
      v.play(); document.getElementById('a').play();
    }, { once: true }));
    await p.click('#b');
    await p.waitForTimeout(1000);
    const r = await p.evaluate(async () => {
      const a = document.getElementById('a'), v = document.getElementById('v'), keep = document.getElementById('keep');
      const t0 = [a.currentTime, v.currentTime];
      if (!document.startViewTransition) return { vt: 'none' };
      keep.style.viewTransitionName = 'sn-keep-x';
      keep.style.setProperty('view-transition-class', 'sn-keep');
      let ran = false;
      const t = document.startViewTransition({ update: () => {
        // the swap's commit: the new body's content in, the kept element moved to its place, the old out
        const body = document.body, old = [...body.childNodes];
        const next = new DOMParser().parseFromString('<main><p>new page</p></main><aside id=slot></aside>', 'text/html');
        body.append(...[...next.body.childNodes].map((n) => document.adoptNode(n)));
        const slot = document.getElementById('slot');
        if (body.moveBefore) body.moveBefore(keep, slot); else body.insertBefore(keep, slot);
        slot.remove();
        for (const n of old) if (n !== keep) n.remove();
      }, types: ['sn-push'] });
      await t.ready.then(() => { ran = true; }, () => {});
      await t.finished.catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      return {
        transition: ran, audio: { paused: a.paused, advanced: +(a.currentTime - t0[0]).toFixed(2) },
        video: { paused: v.paused, advanced: +(v.currentTime - t0[1]).toFixed(2) }, page: document.querySelector('main p').textContent,
      };
    });
    console.log(w, JSON.stringify(r));
    await b.close();
  }
  srv.close();
});

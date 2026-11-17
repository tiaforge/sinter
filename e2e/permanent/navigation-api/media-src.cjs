// Does setting a playing <audio>'s src to the same value restart it?
const pw = require('playwright');
const { createServer } = require('node:http');
const rate = 8000, n = rate * 6, wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin(i / 10) * 3000), 44 + i * 2);
const srv = createServer((req, res) => {
  if (req.url === '/t.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wav); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><audio id=a src="/t.wav" controls></audio><button id=b>b</button>');
});
srv.listen(0, async () => {
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(w === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : w === 'firefox' ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } } : {});
    const p = await b.newPage();
    await p.goto('http://127.0.0.1:' + srv.address().port + '/');
    await p.evaluate(() => document.getElementById('b').addEventListener('click', () => document.getElementById('a').play(), { once: true }));
    await p.click('#b'); await p.waitForTimeout(1200);
    const r = await p.evaluate(async () => {
      const a = document.getElementById('a'), before = a.currentTime;
      a.setAttribute('src', a.getAttribute('src'));      // the same value
      await new Promise((r) => setTimeout(r, 300));
      const same = { before: +before.toFixed(2), after: +a.currentTime.toFixed(2), paused: a.paused };
      return same;
    });
    console.log(w, 'setAttribute(src, same value):', JSON.stringify(r));
    await b.close();
  }
  srv.close();
});

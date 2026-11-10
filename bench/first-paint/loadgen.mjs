// open-loop load: `rate` requests per second to `url` (not waiting for answers), until killed; prints latency on exit
import http from 'node:http';
const [url, rate] = [process.argv[2], +process.argv[3]];
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const lat = [];
let errors = 0;
const fire = () => {
  const t = performance.now();
  http.get(url, { agent, headers: { 'accept-encoding': 'gzip' } }, (res) => { res.on('data', () => {}); res.on('end', () => lat.push(performance.now() - t)); }).on('error', () => errors++);
};
const iv = setInterval(fire, 1000 / rate);
const done = () => {
  clearInterval(iv);
  lat.sort((a, b) => a - b);
  const q = (p) => (lat.length ? lat[Math.floor(lat.length * p)].toFixed(0) : '-');
  console.log(JSON.stringify({ n: lat.length, p50: q(0.5), p90: q(0.9), errors }));
  process.exit(0);
};
process.on('SIGTERM', done);
process.on('SIGINT', done);

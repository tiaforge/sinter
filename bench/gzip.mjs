// gzip for a fetch handler's responses, flushed after each chunk of the body (sinter/server sends one
// before each wait, so a page's head still goes out first). Each chunk is deflated on its own with
// node:zlib's synchronous, native deflate and ends on a sync flush; the gzip header and CRC-32 trailer go
// around them: one standard gzip stream. A chunk cannot refer back into the one before it (a few percent
// larger than one deflate over the page), and nothing crosses to zlib's thread pool, which node:zlib's
// streams do on every write and flush (about twice as slow on Node and Bun) and CompressionStream holds
// the output until the end (no page head first). Node, Bun and Deno.
import zlib from 'node:zlib';

const HEAD = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255);
const crc32 = zlib.crc32 ?? ((data, value) => Bun.hash.crc32(data, value));
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg)/;

/** The response, gzipped when the request accepts it and its type is text. */
export function gzip(request, response) {
  const type = response.headers.get('content-type') ?? '';
  if (!response.body || response.headers.has('content-encoding') || !/\bgzip\b/.test(request.headers.get('accept-encoding') ?? '') || !COMPRESSIBLE.test(type)) return response;
  const reader = response.body.getReader();
  let crc = 0, size = 0, started = false, next = null;
  const NONE = Promise.resolve(null);
  const body = new ReadableStream({
    async pull(c) {
      let { done, value } = await (next ?? reader.read());
      next = null;
      // the chunks already queued behind it, deflated with it: one flush for what the page sends together
      // (a read of a queued chunk is a settled promise, so it wins the race; one still to come loses it)
      if (!done) {
        const more = [value];
        for (;;) {
          const r = reader.read(), got = await Promise.race([r, NONE]);
          if (got == null) { next = r; break; }
          if (got.done) { done = true; break; }
          more.push(got.value);
        }
        if (more.length > 1) value = Buffer.concat(more);
      }
      if (!started) { started = true; c.enqueue(HEAD); }
      if (done && value == null) {
        const end = new Uint8Array(10);
        end.set(zlib.deflateRawSync(new Uint8Array(0), { level: 6 }), 0); // the final, empty block: 2 bytes
        const v = new DataView(end.buffer);
        v.setUint32(2, crc >>> 0, true);
        v.setUint32(6, size >>> 0, true);
        c.enqueue(end);
        c.close();
        return;
      }
      crc = crc32(value, crc);
      size += value.length;
      c.enqueue(zlib.deflateRawSync(value, { level: 6, finishFlush: zlib.constants.Z_SYNC_FLUSH }));
      if (done) next = Promise.resolve({ done: true });
    },
    cancel: (reason) => reader.cancel(reason),
  });
  const headers = new Headers(response.headers);
  headers.set('content-encoding', 'gzip');
  headers.append('vary', 'Accept-Encoding');
  headers.delete('content-length');
  return new Response(body, { status: response.status, headers });
}

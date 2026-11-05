// JSON-RPC 2.0 with LSP's `Content-Length` framing, over any pair of streams. Used
// toward the editor and toward TypeScript's language server.
import type { Readable, Writable } from 'node:stream';

type Handler = (params: any) => unknown;

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export class Connection {
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private requests = new Map<string, Handler>();
  private notifications = new Map<string, Handler>();
  private closed = false;
  /** called for a notification nothing handles */
  onUnhandled?: (method: string, params: unknown) => void;
  onClose?: () => void;

  constructor(input: Readable, private output: Writable) {
    input.on('data', (chunk: Buffer) => this.receive(chunk));
    input.on('end', () => this.close());
    input.on('close', () => this.close());
  }

  onRequest(method: string, handler: Handler): void { this.requests.set(method, handler); }
  onNotification(method: string, handler: Handler): void { this.notifications.set(method, handler); }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`connection closed (${method})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.send({ method, params });
  }

  private send(message: object): void {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private receive(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString('ascii'));
      if (!m) { this.buf = this.buf.subarray(end + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < end + 4 + len) return;
      const body = this.buf.subarray(end + 4, end + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(end + 4 + len);
      let msg: any;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? null);
      return;
    }
    if (msg.id === undefined) {
      const h = this.notifications.get(msg.method);
      if (h) {
        try { void Promise.resolve(h(msg.params)).catch((e) => this.log(msg.method, e)); } catch (e) { this.log(msg.method, e); }
      } else this.onUnhandled?.(msg.method, msg.params);
      return;
    }
    const h = this.requests.get(msg.method);
    if (!h) {
      this.send({ id: msg.id, error: { code: -32601, message: `unhandled method ${msg.method}` } });
      return;
    }
    Promise.resolve()
      .then(() => h(msg.params))
      .then(
        (result) => this.send({ id: msg.id, result: result ?? null }),
        (e: unknown) => this.send({ id: msg.id, error: { code: e instanceof RpcError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } }),
      );
  }

  private log(method: string, e: unknown): void {
    process.stderr.write(`sinter lsp: ${method}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('connection closed'));
    this.pending.clear();
    this.onClose?.();
  }
}

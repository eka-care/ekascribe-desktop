import { EventEmitter } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type NativeBridgeRole = 'client' | 'server' | 'stdio';

export type NativeBridgeConnectOptions =
  | {
      role: 'client';
      host: string;
      port: number;
      /**
       * Automatically reconnect on connection loss.
       * Defaults to false.
       */
      autoReconnect?: boolean;
      /**
       * Base delay for reconnect backoff.
       * Defaults to 250ms.
       */
      reconnectBaseDelayMs?: number;
      /**
       * Max delay for reconnect backoff.
       * Defaults to 5000ms.
       */
      reconnectMaxDelayMs?: number;
    }
  | {
      role: 'server';
      host?: string;
      port: number;
      /**
       * If true, only keep one active socket at a time.
       * Defaults to true.
       */
      singleClient?: boolean;
      /**
       * If the underlying TCP server errors/closes, restart it.
       * Defaults to true.
       */
      autoRestart?: boolean;
      /**
       * Base delay for server restart backoff.
       * Defaults to 250ms.
       */
      restartBaseDelayMs?: number;
      /**
       * Max delay for server restart backoff.
       * Defaults to 5000ms.
       */
      restartMaxDelayMs?: number;
    }
  | {
      /**
       * Stdio transport: parent reads from a child's stdout and writes to its stdin.
       * Streams are attached separately via `attachStdio()` so a single bridge
       * instance can survive helper respawns.
       */
      role: 'stdio';
    };

export type NativeBridgeRequestOptions = {
  timeoutMs?: number;
};

export type NativeBridgeError = {
  code: string;
  message: string;
  data?: JsonValue;
};

type BridgeMessage =
  | PingMessage
  | PongMessage
  | RequestMessage
  | ResponseMessage
  | EventMessage;

type BaseMessage = {
  v: 1;
  id: string;
  ts: number;
};

type PingMessage = BaseMessage & {
  kind: 'ping';
};

type PongMessage = BaseMessage & {
  kind: 'pong';
};

type RequestMessage = BaseMessage & {
  kind: 'request';
  name: string;
  payload?: JsonValue;
};

type ResponseMessage = BaseMessage & {
  kind: 'response';
  replyTo: string;
  ok: boolean;
  payload?: JsonValue;
  error?: NativeBridgeError;
};

type EventMessage = BaseMessage & {
  kind: 'event';
  name: string;
  payload?: JsonValue;
};

type PendingRequest = {
  resolve: (value: JsonValue | undefined) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
};

export type NativeBridgeEvents = {
  connected: () => void;
  disconnected: (reason?: string) => void;
  message: (msg: BridgeMessage) => void;
  event: (name: string, payload: JsonValue | undefined) => void;
  error: (err: Error) => void;
};

/**
 * NativeBridge: structured, two-way bridge between Electron (Node) and a native helper.
 *
 * Transports:
 * - TCP (`role: 'client' | 'server'`)
 * - stdio (`role: 'stdio'`) — frames flow over a child process's stdin/stdout
 *
 * Protocol framing: [uint32be length][utf8 JSON bytes]
 * Envelope: { v:1, id, ts, kind, ... }
 *
 * Message types:
 * - request/response: correlated RPC-style calls
 * - event: fire-and-forget notifications
 * - ping/pong: liveness
 */
export class NativeBridge {
  static onParseError: ((error: Error) => void) | null = null;

  private readonly emitter = new EventEmitter();
  private readonly opts: NativeBridgeConnectOptions;

  private socket: net.Socket | null = null;
  private server: net.Server | null = null;

  private stdioInput: Readable | null = null;
  private stdioOutput: Writable | null = null;

  private inboundBuffer: Buffer = Buffer.alloc(0);
  private disposed = false;

  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  private readonly pendingById = new Map<string, PendingRequest>();

  constructor(opts: NativeBridgeConnectOptions) {
    this.opts = opts;
  }

  on<E extends keyof NativeBridgeEvents>(event: E, listener: NativeBridgeEvents[E]): this {
    this.emitter.on(event, listener);
    return this;
  }

  once<E extends keyof NativeBridgeEvents>(event: E, listener: NativeBridgeEvents[E]): this {
    this.emitter.once(event, listener);
    return this;
  }

  off<E extends keyof NativeBridgeEvents>(event: E, listener: NativeBridgeEvents[E]): this {
    this.emitter.off(event, listener);
    return this;
  }

  isConnected(): boolean {
    if (this.socket && !this.socket.destroyed) return true;
    if (this.stdioOutput && !this.stdioOutput.destroyed) return true;
    return false;
  }

  /**
   * For server role, returns the bound address once listening.
   */
  getServerAddress(): AddressInfo | null {
    const address = this.server?.address();
    if (!address || typeof address === 'string') return null;
    return address;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('NativeBridge is disposed');
    if (this.opts.role === 'client') {
      await this.connectClient();
      return;
    }
    if (this.opts.role === 'server') {
      await this.listenServer();
      return;
    }
    // role: 'stdio' — transport is wired separately via attachStdio() so the
    // bridge can be rebuilt against a fresh child after each respawn.
  }

  /**
   * Wire the bridge to a child process's stdout (incoming) and stdin (outgoing).
   * Safe to call multiple times; previous streams are detached first.
   */
  attachStdio(input: Readable, output: Writable): void {
    if (this.opts.role !== 'stdio') {
      throw new Error('attachStdio is only valid when role is "stdio"');
    }
    if (this.disposed) throw new Error('NativeBridge is disposed');

    this.detachStdio('replaced');

    this.stdioInput = input;
    this.stdioOutput = output;
    this.inboundBuffer = Buffer.alloc(0);

    const onData = (chunk: Buffer | string) => {
      this.onData(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    };
    const onClose = () => this.onStdioClosed('stdio-closed');
    const onError = (err: Error) => this.emitter.emit('error', err);

    input.on('data', onData);
    input.once('end', () => this.onStdioClosed('stdio-end'));
    input.once('close', onClose);
    input.once('error', onError);
    output.once('error', onError);
    output.once('close', () => this.onStdioClosed('stdio-output-closed'));

    this.emitter.emit('connected');
  }

  async stop(): Promise<void> {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.clearRestartTimer();
    this.restartAttempt = 0;
    this.closeSocket('stop');
    this.detachStdio('stop');
    await this.closeServer();
  }

  dispose(): void {
    this.disposed = true;
    void this.stop();
    this.emitter.removeAllListeners();
    for (const [id, pending] of this.pendingById) {
      pending.timer && clearTimeout(pending.timer);
      pending.reject(new Error(`Bridge disposed while awaiting response (id=${id})`));
    }
    this.pendingById.clear();
  }

  /**
   * Send a fire-and-forget event to the native side.
   */
  sendEvent<TPayload extends JsonValue | undefined>(name: string, payload?: TPayload): void {
    console.log('[NativeBridge] sendEvent', name, payload);
    const msg: EventMessage = {
      v: 1,
      id: randomUUID(),
      ts: Date.now(),
      kind: 'event',
      name,
      payload,
    };
    this.writeMessage(msg);
  }
  /**
   * "Hook" to receive incoming event-style messages.
   * Returns an unsubscribe function.
   */
  onReceive(handler: (eventName: string, payload: JsonValue | undefined) => void): () => void {
    const listener = (name: string, payload: JsonValue | undefined) => handler(name, payload);
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /**
   * Register a handler for incoming request-style messages from the native side.
   * The handler receives a `respond` object to send ok/error replies.
   * Returns an unsubscribe function.
   */
  onRequest(
    handler: (
      name: string,
      payload: JsonValue | undefined,
      respond: { ok: (payload?: JsonValue) => void; error: (err: NativeBridgeError) => void },
    ) => void,
  ): () => void {
    const listener = (msg: BridgeMessage) => {
      if (msg.kind !== 'request') return;
      handler(msg.name, msg.payload, {
        ok: (p) => this.respondOk(msg.id, p),
        error: (e) => this.respondError(msg.id, e),
      });
    };
    this.emitter.on('message', listener);
    return () => this.emitter.off('message', listener);
  }

  /**
   * Request/response style call. The native side must respond with a `response` where replyTo=request.id.
   */
  request<TResponse extends JsonValue | undefined = JsonValue | undefined, TPayload extends JsonValue | undefined = JsonValue | undefined>(
    name: string,
    payload?: TPayload,
    options?: NativeBridgeRequestOptions
  ): Promise<TResponse> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const id = randomUUID();

    const msg: RequestMessage = {
      v: 1,
      id,
      ts: Date.now(),
      kind: 'request',
      name,
      payload,
    };

    return new Promise<TResponse>((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('NativeBridge is not connected'));
        return;
      }

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingById.delete(id);
              reject(new Error(`NativeBridge request timed out: ${name} (id=${id})`));
            }, timeoutMs)
          : undefined;

      this.pendingById.set(id, {
        resolve: (value) => resolve(value as TResponse),
        reject,
        timer,
      });

      try {
        this.writeMessage(msg);
      } catch (err) {
        this.pendingById.delete(id);
        timer && clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('Failed to write request'));
      }
    });
  }

  /**
   * Low-level responder helper for server-side (native helper could also implement this).
   * On the Electron side, you can use this when the native app calls `request`.
   */
  respondOk(replyTo: string, payload?: JsonValue): void {
    const msg: ResponseMessage = {
      v: 1,
      id: randomUUID(),
      ts: Date.now(),
      kind: 'response',
      replyTo,
      ok: true,
      payload,
    };
    this.writeMessage(msg);
  }

  respondError(replyTo: string, error: NativeBridgeError): void {
    const msg: ResponseMessage = {
      v: 1,
      id: randomUUID(),
      ts: Date.now(),
      kind: 'response',
      replyTo,
      ok: false,
      error,
    };
    this.writeMessage(msg);
  }

  ping(): void {
    const msg: PingMessage = { v: 1, id: randomUUID(), ts: Date.now(), kind: 'ping' };
    this.writeMessage(msg);
  }

  private async connectClient(): Promise<void> {
    if (this.opts.role !== 'client') throw new Error('connectClient called for non-client role');
    const { host, port } = this.opts;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const onError = (err: Error) => {
        socket.removeAllListeners();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        this.attachSocket(socket);
        resolve();
      });
    });
  }

  private async listenServer(): Promise<void> {
    if (this.opts.role !== 'server') throw new Error('listenServer called for non-server role');
    const host = this.opts.host;
    const port = this.opts.port;
    const singleClient = this.opts.singleClient ?? true;
    const autoRestart = this.opts.autoRestart ?? true;

    this.server = net.createServer((socket) => {
      if (this.disposed) {
        socket.destroy();
        return;
      }
      if (singleClient && this.socket && this.socket.destroyed === false) {
        this.closeSocket('replaced-by-new-client');
      }
      this.attachSocket(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      const onError = (err: Error) => {
        // If we haven't started listening yet, fail start().
        // If we're already live, try to restart if requested.
        if (!srv.listening) {
          reject(err);
          return;
        }
        this.emitter.emit('error', err);
        if (autoRestart && !this.disposed) {
          void this.restartServer();
        }
      };
      srv.on('error', onError);
      srv.listen(port, host, () => {
        srv.off('error', onError);
        resolve();
      });
    });
  }

  private attachSocket(socket: net.Socket): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;

    this.socket = socket;
    this.inboundBuffer = Buffer.alloc(0);

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    socket.once('close', () => this.onSocketClosed());
    socket.once('error', (err) => this.emitter.emit('error', err));

    this.emitter.emit('connected');
  }

  private onSocketClosed(): void {
    // Reject any in-flight requests; this avoids dangling promises.
    for (const [id, pending] of this.pendingById) {
      pending.timer && clearTimeout(pending.timer);
      pending.reject(new Error(`NativeBridge disconnected while awaiting response (id=${id})`));
    }
    this.pendingById.clear();

    this.socket = null;
    this.emitter.emit('disconnected', 'socket-closed');

    if (this.opts.role === 'client' && this.opts.autoReconnect && !this.disposed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.opts.role !== 'client') return;
    this.clearReconnectTimer();
    const base = this.opts.reconnectBaseDelayMs ?? 250;
    const max = this.opts.reconnectMaxDelayMs ?? 5000;
    const attempt = this.reconnectAttempt++;

    const delay = Math.min(max, base * Math.pow(2, attempt));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      void this.connectClient().catch((err) => {
        this.emitter.emit('error', err instanceof Error ? err : new Error('Reconnect failed'));
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private closeSocket(reason?: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;

    try {
      socket.removeAllListeners();
      socket.destroy();
    } catch {
      // ignore
    }

    this.emitter.emit('disconnected', reason);
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async restartServer(): Promise<void> {
    if (this.opts.role !== 'server') return;
    this.clearRestartTimer();

    const base = this.opts.restartBaseDelayMs ?? 250;
    const max = this.opts.restartMaxDelayMs ?? 5000;
    const attempt = this.restartAttempt++;
    const delay = Math.min(max, base * Math.pow(2, attempt));

    await this.closeServer();

    await new Promise<void>((resolve) => {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        resolve();
      }, delay);
    });

    if (this.disposed) return;

    try {
      await this.listenServer();
      this.restartAttempt = 0;
    } catch (err) {
      this.emitter.emit('error', err instanceof Error ? err : new Error('Server restart failed'));
      if (!this.disposed) {
        await this.restartServer();
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.inboundBuffer = Buffer.concat([this.inboundBuffer, chunk]);

    // Parse as many complete frames as possible.
    while (this.inboundBuffer.length >= 4) {
      const frameLen = this.inboundBuffer.readUInt32BE(0);
      if (frameLen <= 0) {
        this.emitter.emit('error', new Error('Invalid frame length'));
        this.closeActiveTransport('invalid-frame');
        return;
      }

      if (this.inboundBuffer.length < 4 + frameLen) return;

      const jsonBytes = this.inboundBuffer.subarray(4, 4 + frameLen);
      this.inboundBuffer = this.inboundBuffer.subarray(4 + frameLen);

      try {
        const parsed = JSON.parse(jsonBytes.toString('utf8')) as unknown;
        const msg = this.validateMessage(parsed);
        if (!msg) continue;
        this.emitter.emit('message', msg);
        this.dispatchMessage(msg);
      } catch (err) {
        const parseError = err instanceof Error ? err : new Error('Failed to parse message');
        this.emitter.emit('error', parseError);
        NativeBridge.onParseError?.(parseError);
      }
    }
  }

  private dispatchMessage(msg: BridgeMessage): void {
    switch (msg.kind) {
      case 'ping':
        this.writeMessage({ v: 1, id: randomUUID(), ts: Date.now(), kind: 'pong' });
        return;
      case 'pong':
        return;
      case 'event':
        this.emitter.emit('event', msg.name, msg.payload);
        return;
      case 'response': {
        const pending = this.pendingById.get(msg.replyTo);
        if (!pending) return;
        this.pendingById.delete(msg.replyTo);
        pending.timer && clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve(msg.payload);
        } else {
          const e = msg.error
            ? new Error(`NativeBridge error [${msg.error.code}]: ${msg.error.message}`)
            : new Error('NativeBridge response error');
          pending.reject(e);
        }
        return;
      }
      case 'request':
        // Electron side can choose to handle request messages via `message` event and respond using respondOk/respondError.
        return;
      default: {
        const _exhaustive: never = msg;
        return _exhaustive;
      }
    }
  }

  private writeMessage(msg: BridgeMessage): void {
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, 'utf8');
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);

    const socket = this.socket;
    if (socket && !socket.destroyed) {
      socket.write(frame);
      return;
    }
    const out = this.stdioOutput;
    if (out && !out.destroyed) {
      out.write(frame);
      return;
    }
    throw new Error('NativeBridge is not connected');
  }

  private closeActiveTransport(reason: string): void {
    if (this.socket) this.closeSocket(reason);
    if (this.stdioInput || this.stdioOutput) this.detachStdio(reason);
  }

  private detachStdio(reason?: string): void {
    const input = this.stdioInput;
    const output = this.stdioOutput;
    if (!input && !output) return;
    this.stdioInput = null;
    this.stdioOutput = null;
    try { input?.removeAllListeners(); } catch { /* ignore */ }
    try { output?.removeAllListeners(); } catch { /* ignore */ }
    // We deliberately do NOT end()/destroy() the streams here; the parent
    // process owns the child lifecycle and closes them by killing the child.
    this.emitter.emit('disconnected', reason);
  }

  private onStdioClosed(reason: string): void {
    if (!this.stdioInput && !this.stdioOutput) return;
    for (const [id, pending] of this.pendingById) {
      pending.timer && clearTimeout(pending.timer);
      pending.reject(new Error(`NativeBridge disconnected while awaiting response (id=${id})`));
    }
    this.pendingById.clear();
    this.detachStdio(reason);
  }

  private validateMessage(input: unknown): BridgeMessage | null {
    if (!input || typeof input !== 'object') return null;
    const msg = input as Partial<Record<string, unknown>>;
    if (msg.v !== 1) return null;
    if (typeof msg.id !== 'string') return null;
    if (typeof msg.ts !== 'number') return null;
    if (typeof msg.kind !== 'string') return null;

    switch (msg.kind) {
      case 'ping':
        return { v: 1, id: msg.id, ts: msg.ts, kind: 'ping' };
      case 'pong':
        return { v: 1, id: msg.id, ts: msg.ts, kind: 'pong' };
      case 'event':
        if (typeof msg.name !== 'string') return null;
        return {
          v: 1,
          id: msg.id,
          ts: msg.ts,
          kind: 'event',
          name: msg.name,
          payload: (msg.payload ?? undefined) as JsonValue | undefined,
        };
      case 'request':
        if (typeof msg.name !== 'string') return null;
        return {
          v: 1,
          id: msg.id,
          ts: msg.ts,
          kind: 'request',
          name: msg.name,
          payload: (msg.payload ?? undefined) as JsonValue | undefined,
        };
      case 'response':
        if (typeof msg.replyTo !== 'string') return null;
        if (typeof msg.ok !== 'boolean') return null;
        return {
          v: 1,
          id: msg.id,
          ts: msg.ts,
          kind: 'response',
          replyTo: msg.replyTo,
          ok: msg.ok,
          payload: (msg.payload ?? undefined) as JsonValue | undefined,
          error: (msg.error ?? undefined) as NativeBridgeError | undefined,
        };
      default:
        return null;
    }
  }
}


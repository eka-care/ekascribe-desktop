import { Readable } from 'node:stream';
import type { Server as HttpServer } from 'node:http';
import express, { type Request, type Response } from 'express';
import { ipcMain, net } from 'electron';
import {
  API_PROXY_HOST,
  API_PROXY_ORIGIN,
  API_PROXY_PORT,
  getApiUpstreamBase,
} from '../config';
import { getAuthToken } from './authManager';
import { refreshConnectAuthTokensDeduped } from './connectAuthRefresh';
import { captureError } from './sentryManager';
import { injectElectronEnv } from './ekascribeWebManager';

/**
 * Main-process Express API proxy — the app's single network egress.
 *
 * The embedded ekascribe-web app (`external/ekascribe/apps/web`) points every backend
 * URL at {@link API_PROXY_ORIGIN}, so all of its traffic — raw `fetch()` from the vendored
 * scribe SDK as well as calls routed over the `network:request` IPC channel — lands here
 * before leaving the machine. That gives one place to attach credentials, refresh expired
 * tokens, and observe every request, instead of spreading auth across the renderer.
 *
 * The server binds to loopback only and rejects requests whose `Host` header is not
 * loopback, so a hostile page on the network can't use it as an open relay.
 */

const DEFAULT_CLIENT_ID = 'doc-web';
const FLAVOUR = process.platform === 'win32' ? 'ekascribe-desktop-windows' : 'ekascribe-desktop-mac';

// Generous: audio uploads and long-running transcription polls both come through here.
const UPSTREAM_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 256 * 1024 * 1024;

// The refresh endpoint must never trigger the 401 refresh-and-retry path — a rejected
// refresh answering 401 would otherwise recurse.
const REFRESH_PATH = '/connect-auth/v1/account/refresh-token';

/**
 * Dropped from the forwarded request. Hop-by-hop headers (RFC 9110 §7.6.1) describe this
 * loopback connection, not the upstream one; `content-length` is recomputed from the
 * buffered body; `origin`/`referer` would leak the loopback origin and trip upstream CORS
 * checks; `accept-encoding` is left to `net.fetch`, which decodes transparently.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'accept-charset',
  'origin',
  'referer',
  'date',
  'expect',
  'via',
  'dnt',
]);

/**
 * Header prefixes the browser's own network stack owns. Chromium refuses to let a caller
 * set these on an outgoing request — forwarding `Sec-Fetch-Mode` verbatim makes `net.fetch`
 * reject the whole call with `ERR_INVALID_ARGUMENT`. They describe the renderer→proxy hop
 * anyway, so they'd be wrong to replay against the upstream even if they were allowed.
 */
const STRIPPED_REQUEST_HEADER_PREFIXES = ['sec-', 'proxy-', 'access-control-request-'];

function isStrippedRequestHeader(name: string): boolean {
  return (
    STRIPPED_REQUEST_HEADERS.has(name) ||
    STRIPPED_REQUEST_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Dropped from the forwarded response. `net.fetch` hands back a decoded body, so echoing
 * the upstream `content-encoding`/`content-length` would make the renderer try to gunzip
 * plain bytes. CORS headers are replaced with ones valid for the loopback origin.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
]);

const ALLOWED_REQUEST_HEADERS =
  'Content-Type, Authorization, auth, client-id, flavour, X-Requested-With, Accept, ' +
  'Accept-Language, Content-Language, Range, Cache-Control, Pragma';

let proxyServer: HttpServer | null = null;
let startPromise: Promise<string> | null = null;

/** Origin the embedded web app and the renderer should address for all backend calls. */
export function getApiProxyOrigin(): string {
  return API_PROXY_ORIGIN;
}

export function registerApiProxyIpcHandlers(): void {
  // Synchronous so `preload` can hand the origin to the page before any app script runs
  // (ekascribe-web reads it while evaluating its host table at module load).
  ipcMain.on('api-proxy:originSync', (event) => {
    event.returnValue = API_PROXY_ORIGIN;
  });
  ipcMain.handle('api-proxy:origin', () => API_PROXY_ORIGIN);
}

export async function startApiProxy(): Promise<string> {
  if (proxyServer?.listening) {
    return API_PROXY_ORIGIN;
  }
  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    // EKA_API_UPSTREAM lives in electron.env; load it before the first request resolves it.
    injectElectronEnv();

    const app = express();
    app.disable('x-powered-by');
    // No body parser: bodies are streamed into a buffer verbatim so binary uploads
    // (audio chunks, PDFs) survive the hop unmodified.

    // First middleware so it also covers /healthz: only a caller that actually resolved
    // loopback may use the proxy, which blocks DNS rebinding from a page on the network.
    app.use((req, res, next) => {
      if (!isLoopbackHost(req.headers.host)) {
        res.status(403).type('text/plain').send('Forbidden');
        return;
      }
      next();
    });

    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, upstream: getApiUpstreamBase() });
    });

    app.use(handleProxyRequest);

    const server = await listen(app);
    proxyServer = server;

    console.log(
      `[apiProxy] listening on ${API_PROXY_ORIGIN} -> ${getApiUpstreamBase()}`,
    );
    return API_PROXY_ORIGIN;
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function stopApiProxy(): Promise<void> {
  const server = proxyServer;
  proxyServer = null;
  if (!server) return;

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // close() waits for keep-alive sockets; don't let shutdown hang on them.
    server.closeAllConnections?.();
  });
  console.log('[apiProxy] stopped');
}

function listen(app: express.Express): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(API_PROXY_PORT, API_PROXY_HOST, () => resolve(server));
    server.once('error', reject);
  });
}

async function handleProxyRequest(req: Request, res: Response): Promise<void> {
  applyCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const targetUrl = `${getApiUpstreamBase()}${req.originalUrl}`;

  let body: Buffer | null;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    console.warn('[apiProxy] failed reading request body', { url: req.originalUrl, error: String(error) });
    res.status(413).type('text/plain').send('Request body too large');
    return;
  }

  const headers = buildUpstreamHeaders(req);
  const clientId = headers['client-id'] ?? DEFAULT_CLIENT_ID;

  let upstream: Response_ | null = await fetchUpstream(req.method, targetUrl, headers, body, res);
  if (!upstream) return; // fetchUpstream already answered with the error status

  // Expired access token: refresh once through the deduped refresher, then replay the
  // request with the fresh token. The buffered body makes the replay possible.
  if (upstream.status === 401 && !req.originalUrl.startsWith(REFRESH_PATH)) {
    console.warn('[apiProxy] 401 — attempting refresh and retry', { url: req.originalUrl });
    const { ok: refreshed } = await refreshConnectAuthTokensDeduped('', clientId);
    if (refreshed) {
      const freshToken = getAuthToken();
      if (freshToken) headers.auth = freshToken;
      const retried = await fetchUpstream(req.method, targetUrl, headers, body, res);
      if (!retried) return;
      upstream = retried;
    }
  }

  console.log('[apiProxy]', req.method, req.originalUrl, '->', upstream.status);
  await pipeUpstreamResponse(upstream, res);
}

/**
 * `net.fetch` returns the DOM `Response`; alias it so the name doesn't collide with
 * Express's `Response` in this module.
 */
type Response_ = globalThis.Response;

/**
 * Performs the upstream call. On a connection-level failure (offline, DNS, timeout) it
 * answers the client with 502 and resolves `null` — status 0 has no HTTP equivalent, and
 * a distinct gateway error keeps callers from mistaking it for an auth failure.
 */
async function fetchUpstream(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer | null,
  res: Response,
): Promise<Response_ | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return (await (net.fetch as Function)(url, {
      method,
      headers,
      body: body ?? undefined,
      credentials: 'include',
      signal: controller.signal,
      // Skip the app-wide `https` protocol handler (managers/proxyManager.ts) so this
      // request goes straight out instead of re-entering the interceptor.
      bypassCustomProtocolHandlers: true,
    })) as Response_;
  } catch (error) {
    console.warn('[apiProxy] upstream request failed', { method, url, error: String(error) });
    captureError(error, { domain: 'infra', component: 'api_proxy', extra: { method, url } });
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream_unreachable', message: String(error) });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pipeUpstreamResponse(upstream: Response_, res: Response): Promise<void> {
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(name)) return;
    if (name.startsWith('access-control-')) return; // ours already set by applyCorsHeaders
    if (name === 'set-cookie') return; // handled below — `forEach` mangles it
    res.setHeader(key, value);
  });

  const setCookies = (upstream.headers.getSetCookie?.() ?? []).flatMap(splitSetCookie);
  if (setCookies.length > 0) {
    res.setHeader('Set-Cookie', setCookies);
  }

  res.status(upstream.status);

  if (!upstream.body) {
    res.end();
    return;
  }

  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  await new Promise<void>((resolve) => {
    stream.on('error', (error) => {
      console.warn('[apiProxy] response stream error', String(error));
      res.destroy();
      resolve();
    });
    res.on('close', resolve);
    stream.pipe(res).on('finish', resolve);
  });
}

/**
 * Chromium merges multiple upstream Set-Cookie headers into one comma-joined string before
 * the `Headers` object sees them, so even `getSetCookie()` hands back a single entry. Sent
 * on as-is the browser reads it as ONE cookie and silently drops the rest — the tail ends up
 * absorbed into the first cookie's `Path` attribute.
 *
 * Split only on a comma that starts a new `name=` pair. The commas inside an
 * `Expires=Mon, 17 Aug 2026 …` date are followed by a bare date, which can't match, so they
 * survive. Already-separate values pass through untouched.
 */
function splitSetCookie(value: string): string[] {
  return value.split(/,\s*(?=[^;=,\s]+=)/);
}

function buildUpstreamHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (isStrippedRequestHeader(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  // The renderer never holds the token; the proxy attaches it. A caller that already
  // supplied one (e.g. an explicit re-auth probe) keeps it.
  if (!headers.auth) {
    const authToken = getAuthToken();
    if (authToken) headers.auth = authToken;
  }
  if (!headers['client-id']) {
    headers['client-id'] = DEFAULT_CLIENT_ID;
  }
  headers.flavour = FLAVOUR;

  return headers;
}

function readRequestBody(req: Request): Promise<Buffer | null> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

function applyCorsHeaders(req: Request, res: Response): void {
  const origin = req.headers.origin;

  if (typeof origin === 'string' && isLoopbackOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] ?? ALLOWED_REQUEST_HEADERS,
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

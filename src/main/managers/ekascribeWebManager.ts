import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { app, ipcMain, net, protocol } from 'electron';
import { ELECTRON_API_ORIGIN, getApiUpstreamBase } from '../config';
import { getAuthToken } from './authManager';
import { refreshConnectAuthTokensDeduped } from './connectAuthRefresh';

/**
 * Dev-only loopback address of the Next dev server. Next needs a real HTTP server for
 * HMR/dev middleware, so in dev the `app://` protocol handler bridges to it. Packaged
 * builds have NO listening socket at all — the static export is read straight from disk
 * inside the protocol handler, so nothing on the machine can address the app's files
 * over HTTP.
 */
const EKASCRIBE_WEB_PORT = 3876;
const EKASCRIBE_WEB_HOST = '127.0.0.1';
const EKASCRIBE_WEB_URL = `http://${EKASCRIBE_WEB_HOST}:${EKASCRIBE_WEB_PORT}`;

/**
 * Custom scheme the window loads from.
 *
 * The point is the *origin*. ekascribe-web builds same-origin relative backend URLs, so
 * API calls land on `app://ekascribe/...` too and the protocol handler forwards them to the
 * upstream (see {@link isApiRequestPath}), stamping the `app://ekascribe` origin the API
 * allowlists. Renderer code that fetches the upstream absolutely still gets that same
 * origin for free from the page's security origin.
 */
const EKASCRIBE_APP_SCHEME = 'app';
const EKASCRIBE_APP_HOST = 'ekascribe';
const EKASCRIBE_APP_ORIGIN = `${EKASCRIBE_APP_SCHEME}://${EKASCRIBE_APP_HOST}`;

/** Origin the window loads from, and the `Origin:` the API sees on renderer calls. */
export function getEkascribeAppOrigin(): string {
  return EKASCRIBE_APP_ORIGIN;
}

/**
 * Must run before `app.whenReady()` — Chromium reads the privilege table during startup and
 * ignores later changes.
 *
 * `standard` is what gives the scheme a parseable origin (without it the page is opaque and
 * every request is cross-origin `null`). `secure` marks it a trustworthy context, which the
 * recorder depends on: `navigator.mediaDevices` is undefined outside a secure context, so
 * without this flag `getUserMedia` in the web app's audio-capture layer breaks outright.
 * `secure` also means the upstream API must be HTTPS — a trustworthy page fetching `http://`
 * is active mixed content and Chromium blocks it with no way to opt back in per-request.
 */
export function registerEkascribeAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EKASCRIBE_APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Dropped from requests the dev bridge forwards to the Next dev server. They describe the
 * renderer→bridge hop, not the loopback one — and `origin` is load-bearing: forwarding it
 * makes `net.fetch` treat the loopback hop as a CORS request and send a preflight, which
 * Next answers 400, failing the whole fetch with ERR_FAILED. Fonts are the only subresource
 * fetched in CORS mode (so the only requests carrying `Origin`), which is why exactly the
 * .woff2 files broke while everything else loaded.
 */
const BRIDGE_STRIPPED_HEADERS = new Set([
  'origin',
  'referer',
  'host',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
]);
const BRIDGE_STRIPPED_HEADER_PREFIXES = ['sec-', 'proxy-', 'access-control-request-'];

function buildBridgeHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    const name = key.toLowerCase();
    if (BRIDGE_STRIPPED_HEADERS.has(name)) return;
    if (BRIDGE_STRIPPED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) return;
    headers.append(key, value);
  });
  return headers;
}

/**
 * Path prefixes owned by the backend API, not the web bundle. ekascribe-web builds
 * same-origin relative URLs (`HOSTS.EKA_HOST === ''`); in production web the FastAPI
 * server answers these itself while serving the static bundle for everything else. The
 * protocol handler replicates that split — anything below misrouted to the static bundle
 * comes back as an HTML 404 page instead of an API response. Mirrors `rewrites()` in
 * `apps/web/next.config.ts` and the router prefixes in `apps/api/src/scribe/main.py`.
 */
const API_PATH_PREFIXES = ['/voice/', '/connect-auth/'];
const API_EXACT_PATHS = new Set(['/healthz']);

// Must never trigger the 401 refresh-and-retry below — a rejected refresh answering 401
// would otherwise recurse.
const API_REFRESH_PATH = '/connect-auth/v1/account/refresh-token';

// Generous: audio-chunk uploads and long transcription polls cross this bridge.
const API_UPSTREAM_TIMEOUT_MS = 120_000;

function isApiRequestPath(pathname: string): boolean {
  return API_EXACT_PATHS.has(pathname) || API_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Serves `app://ekascribe/<path>`: API paths go to the upstream API; everything else is
 * the web bundle — read from disk in packaged builds, bridged to the Next dev server in
 * dev. Registered on the default session after `ready`.
 *
 * In dev, redirects are followed inside `net.fetch`, so a Next-side redirect resolves here
 * and the renderer keeps the `app://` URL it asked for rather than being navigated to
 * loopback — which would silently drop the page back to the wrong origin.
 */
export function registerEkascribeAppProtocol(): void {
  // EKA_API_UPSTREAM lives in electron.env; load it before the first API request needs it.
  injectElectronEnv();

  protocol.handle(EKASCRIBE_APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== EKASCRIBE_APP_HOST) {
      return new Response('Not Found', { status: 404 });
    }

    if (isApiRequestPath(url.pathname)) {
      return proxyApiRequest(request, url);
    }

    if (app.isPackaged) {
      return serveStaticFile(url.pathname);
    }

    // Dev: a window can be created before the Next server finishes booting; idempotent.
    await startEkascribeWeb();

    const target = `${EKASCRIBE_WEB_URL}${url.pathname}${url.search}`;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    try {
      // Buffered rather than streamed: `net.fetch` does not reliably accept a ReadableStream
      // body. Only Next's own traffic crosses this bridge (documents, assets, RSC payloads,
      // server actions) — audio uploads go straight to the API — so bodies stay small.
      const body = hasBody ? await request.arrayBuffer() : undefined;

      return (await (net.fetch as Function)(target, {
        method: request.method,
        headers: buildBridgeHeaders(request.headers),
        body,
        bypassCustomProtocolHandlers: true,
      })) as Response;
    } catch (error) {
      console.error('[ekascribe-web] app:// dev bridge failed for', target, error);
      return new Response('Bad Gateway', { status: 502 });
    }
  });

  console.log(
    `[ekascribe-web] ${EKASCRIBE_APP_ORIGIN} -> ${app.isPackaged ? 'static bundle (in-process)' : EKASCRIBE_WEB_URL} (web), -> ${getApiUpstreamBase()} (api)`,
  );
}

/**
 * Forwards a same-origin API request to the real upstream. This hop is main-process
 * `net.fetch`, so nothing stamps `Origin:` for us and the renderer's webRequest auth hook
 * (networkManager) doesn't apply — both the desktop origin and the bearer token are
 * attached here explicitly. The renderer sees the response as same-origin, so no CORS
 * headers are needed on the way back.
 */
async function proxyApiRequest(request: Request, url: URL): Promise<Response> {
  const target = `${getApiUpstreamBase()}${url.pathname}${url.search}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  try {
    // Buffered rather than streamed (`net.fetch` does not reliably accept a ReadableStream
    // body) — buffering also makes the post-refresh replay below possible.
    const body = hasBody ? await request.arrayBuffer() : undefined;

    const headers = buildBridgeHeaders(request.headers);
    headers.set('origin', ELECTRON_API_ORIGIN);
    if (!headers.has('authorization')) {
      const authToken = getAuthToken();
      if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    }

    let response = await fetchApiUpstream(request.method, target, headers, body);

    // Expired access token: refresh once through the deduped refresher, then replay.
    if (response.status === 401 && !url.pathname.startsWith(API_REFRESH_PATH)) {
      console.warn('[ekascribe-web] api bridge 401 — attempting refresh and retry', url.pathname);
      const { ok: refreshed } = await refreshConnectAuthTokensDeduped('', 'doc-web');
      if (refreshed) {
        const freshToken = getAuthToken();
        if (freshToken) headers.set('authorization', `Bearer ${freshToken}`);
        response = await fetchApiUpstream(request.method, target, headers, body);
      }
    }

    console.log('[ekascribe-web] api bridge', request.method, url.pathname, '->', response.status);
    return response;
  } catch (error) {
    console.error('[ekascribe-web] api bridge failed for', target, error);
    return new Response(JSON.stringify({ error: 'upstream_unreachable', message: String(error) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

async function fetchApiUpstream(
  method: string,
  target: string,
  headers: Headers,
  body: ArrayBuffer | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_UPSTREAM_TIMEOUT_MS);
  try {
    return (await (net.fetch as Function)(target, {
      method,
      headers,
      body,
      signal: controller.signal,
      // Skip the app-wide `https` interceptor (managers/proxyManager.ts) and this handler.
      bypassCustomProtocolHandlers: true,
    })) as Response;
  } finally {
    clearTimeout(timer);
  }
}

type NextAppLike = {
  prepare: () => Promise<void>;
  getRequestHandler: () => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void;
  close?: () => Promise<void>;
};

let ekascribeServer: HttpServer | null = null;
let ekascribeNextApp: NextAppLike | null = null;
let startPromise: Promise<string> | null = null;
let staticRootCache: string | null = null;

export function registerEkascribeWebIpcHandlers(): void {
  ipcMain.handle('ekascribe-web:start', startEkascribeWeb);
  ipcMain.handle('ekascribe-web:stop', stopEkascribeWeb);
  ipcMain.handle('ekascribe-web:url', () => EKASCRIBE_APP_ORIGIN);
}

/**
 * Packaged: resolves (and caches) the static export root — no server, no port. Throws
 * loudly if the export is missing from the bundle; there is deliberately no fallback to
 * running Next in production, which cannot work (the packaged app ships no Next runtime
 * or node_modules) and would only produce a misleading error later.
 *
 * Dev: boots the in-process Next dev server the `app://` bridge forwards to.
 */
export async function startEkascribeWeb(): Promise<string> {
  process.env.NEXT_PUBLIC_APP_SOURCE =
    process.platform === 'win32' ? 'electron-windows' : 'electron-mac';

  if (app.isPackaged) {
    if (!staticRootCache) {
      staticRootCache = resolveEkascribeStaticRoot();
      console.log('[ekascribe-web] serving static bundle from', staticRootCache);
    }
    return EKASCRIBE_APP_ORIGIN;
  }

  if (ekascribeServer?.listening) {
    return EKASCRIBE_APP_ORIGIN;
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    const repoPath = resolveEkascribeRepoPath();
    await ensureDependenciesInstalled(repoPath);
    await startNextServer(repoPath);
    return EKASCRIBE_APP_ORIGIN;
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function stopEkascribeWeb(): Promise<void> {
  const server = ekascribeServer;
  ekascribeServer = null;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (ekascribeNextApp?.close) {
    try {
      await ekascribeNextApp.close();
    } catch (error) {
      console.error('[ekascribe-web] failed closing next app', error);
    }
  }
  ekascribeNextApp = null;
}

async function ensureDependenciesInstalled(repoPath: string): Promise<void> {
  // npm workspaces hoist node_modules to the monorepo root, so the tree may live several
  // levels above the app dir.
  if (findHoistedNodeModules(repoPath)) {
    return;
  }

  const triedPaths = getEkascribeRepoCandidates()
    .map((candidatePath) => `- ${candidatePath}`)
    .join('\n');

  throw new Error(
    `Missing dependencies for ${repoPath} (no node_modules in it or any parent).\nSearched ekascribe-web locations:\n${triedPaths}\nRun "npm install" inside external/ekascribe.`
  );
}

function findHoistedNodeModules(startPath: string): string | null {
  let current = startPath;
  for (; ;) {
    const candidate = path.join(current, 'node_modules');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveEkascribeStaticRoot(): string {
  const candidates = getEkascribeStaticCandidates();
  const existing = candidates.find((candidatePath) =>
    existsSync(path.join(candidatePath, 'index.html'))
  );
  if (existing) {
    return path.resolve(existing);
  }

  const triedPaths = candidates.map((candidatePath) => `- ${candidatePath}`).join('\n');
  throw new Error(
    `Missing static ekascribe-web export (index.html).\nSearched export locations:\n${triedPaths}\nRun "npm run build:ekascribe-web:static" before packaging, then rebuild the desktop app.`
  );
}

function getEkascribeStaticCandidates(): string[] {
  const appPath = appRootPath();
  const resourcesPath = process.resourcesPath;

  return [
    path.join(appPath, 'external', 'ekascribe', 'apps', 'web', 'out'),
    path.join(resourcesPath, 'external', 'ekascribe', 'apps', 'web', 'out'),
    // electron-builder maps the export here; forge's extraResource keeps the bare dir name.
    path.join(resourcesPath, 'ekascribe-web', 'out'),
    path.join(resourcesPath, 'out'),
  ];
}

function isFile(targetPath: string): boolean {
  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Next's static export writes one file per prerendered route, and a dynamic segment is only
 * prerendered for the params `generateStaticParams` returns — `/session/[id]` ships as
 * `session/_.html` plus its `session/_.txt` RSC payload. A real `/session/<id>` request has
 * to resolve to that placeholder: walking up to the nearest index.html instead serves the
 * root shell, which hydrates the wrong route and leaves the session screen on its skeleton.
 * The page reads the id back off the URL, so the shared shell is correct for every id.
 */
function resolveDynamicPlaceholder(root: string, resolvedPath: string): string | null {
  const extension = path.extname(resolvedPath) || '.html';
  let cursor = resolvedPath;
  while (cursor.startsWith(root) && cursor !== root) {
    const placeholder = path.join(path.dirname(cursor), `_${extension}`);
    if (isFile(placeholder)) {
      return placeholder;
    }
    cursor = path.dirname(cursor);
  }
  return null;
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.mjs': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    // Next's app router fetches `<route>.txt` for a prefetched route's RSC payload.
    case '.txt': return 'text/plain; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    default: return 'application/octet-stream';
  }
}

/**
 * Packaged builds: answers `app://ekascribe/<path>` straight from the static export on
 * disk, inside the protocol handler. Replaces the old loopback static server — same
 * fallback ladder, minus the fixed port, the open localhost listener any local process
 * could read the bundle through, and the buffered extra HTTP hop per asset.
 */
async function serveStaticFile(pathname: string): Promise<Response> {
  try {
    const normalizedRoot = staticRootCache ?? (staticRootCache = resolveEkascribeStaticRoot());

    const decodedPath = decodeURIComponent(pathname);
    const safeRelative = decodedPath.replace(/^\/+/, '');
    const requestedPath = safeRelative === '' ? 'index.html' : safeRelative;
    const resolvedPath = path.resolve(normalizedRoot, requestedPath);

    if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(normalizedRoot + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    let targetPath = resolvedPath;
    // A route can collide with a directory of its children (`template.html` beside
    // `template/`), so only a real file counts as a hit — a directory would EISDIR below.
    if (!isFile(targetPath)) {
      const htmlFallback = `${resolvedPath}.html`;
      const nestedIndexFallback = path.join(resolvedPath, 'index.html');
      const placeholderFallback = resolveDynamicPlaceholder(normalizedRoot, resolvedPath);
      if (isFile(htmlFallback)) {
        targetPath = htmlFallback;
      } else if (isFile(nestedIndexFallback)) {
        targetPath = nestedIndexFallback;
      } else if (placeholderFallback) {
        targetPath = placeholderFallback;
      } else {
        // Support legacy dynamic-like paths by walking up to nearest static index.
        let cursor = path.dirname(resolvedPath);
        let matched = '';
        while (cursor.startsWith(normalizedRoot)) {
          const candidate = path.join(cursor, 'index.html');
          if (existsSync(candidate)) {
            matched = candidate;
            break;
          }
          if (cursor === normalizedRoot) {
            break;
          }
          cursor = path.dirname(cursor);
        }
        targetPath = matched || path.join(normalizedRoot, 'index.html');
      }
    }

    const body = await readFile(targetPath);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': getContentType(targetPath) },
    });
  } catch (error) {
    console.error('[ekascribe-web] static request handling failed', pathname, error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function startNextServer(repoPath: string): Promise<void> {
  injectElectronEnv();

  const requireFromEkascribe = createRequire(path.join(repoPath, 'package.json'));
  const nextModule = requireFromEkascribe('next') as (opts: {
    dev: boolean;
    dir: string;
    hostname: string;
    port: number;
  }) => NextAppLike;

  const nextApp = nextModule({
    dev: process.env.NODE_ENV !== 'production',
    dir: repoPath,
    hostname: EKASCRIBE_WEB_HOST,
    port: EKASCRIBE_WEB_PORT,
  });

  await nextApp.prepare();
  const handler = nextApp.getRequestHandler();

  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      console.error('[ekascribe-web] request handling failed', error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end('Internal Server Error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(EKASCRIBE_WEB_PORT, EKASCRIBE_WEB_HOST, () => resolve());
  });

  ekascribeNextApp = nextApp;
  ekascribeServer = server;
}

function appRootPath(): string {
  return app.getAppPath();
}

function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) result[key] = value;
  }
  return result;
}

export function injectElectronEnv(): void {
  const vars = loadEnvFile(path.join(appRootPath(), 'electron.env'));
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in process.env)) process.env[k] = v;
  }
}

/** Dev only — the packaged app serves the static export and never runs Next. */
function resolveEkascribeRepoPath(): string {
  const candidates = getEkascribeRepoCandidates();
  const existing = candidates.find((candidatePath) =>
    existsSync(path.join(candidatePath, 'package.json'))
  );

  if (existing) {
    return existing;
  }

  return candidates[0];
}

function getEkascribeRepoCandidates(): string[] {
  const appPath = appRootPath();
  return [
    // Dev mode: always prefer the web workspace inside the monorepo submodule.
    path.join(appPath, 'external', 'ekascribe', 'apps', 'web'),
    // If appPath differs from workspace root, allow one-level-up fallback.
    path.join(appPath, '..', 'external', 'ekascribe', 'apps', 'web'),
  ];
}

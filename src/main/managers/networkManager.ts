import { ipcMain, net, session } from 'electron';
import { getAuthToken } from './authManager';
import { getApiProxyOrigin } from './apiProxyManager';

export interface NetworkRequestPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  retry: boolean;
  ekaHost: string;
}

export interface NetworkResponsePayload {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_CLIENT_ID = 'doc-web';
const REQUEST_TIMEOUT_MS = 15000;

// Sentinel returned when the request never reached the server (offline / timeout).
// status 0 is the conventional "no HTTP response" marker — callers treat it as a
// network error rather than an auth failure.
const NETWORK_ERROR_RESPONSE: NetworkResponsePayload = {
  status: 0,
  statusText: 'Network Error',
  ok: false,
  headers: {},
  body: '',
};

/**
 * Renderer callers may pass a relative URL ('/connect-auth/...'). The renderer would resolve
 * it against its page origin, but by the time it arrives here over IPC there is no origin
 * left and `net.fetch` rejects with "Failed to parse URL". Resolve against the Express API
 * proxy, which is where the embedded web app's absolute URLs already point.
 */
function toAbsoluteUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    return new URL(url, getApiProxyOrigin()).toString();
  } catch {
    return url;
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = { ...headers };
  if (sanitized.auth) sanitized.auth = '<redacted>';
  if (sanitized.authorization) sanitized.authorization = '<redacted>';
  if (sanitized.cookie) sanitized.cookie = '<redacted>';
  return sanitized;
}

async function executeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
  };

  if (body !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await (net.fetch as Function)(url, {
      ...init,
      signal: controller.signal,
      bypassCustomProtocolHandlers: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function serializeResponse(response: Response): Promise<NetworkResponsePayload> {
  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, statusText: response.statusText, ok: response.ok, headers, body };
}

async function handleNetworkRequest(
  _event: Electron.IpcMainInvokeEvent,
  payload: NetworkRequestPayload,
): Promise<NetworkResponsePayload> {
  const { method, headers, body, retry } = payload;
  const url = toAbsoluteUrl(payload.url);
  const viaProxy = isProxyTarget(url);

  console.log('[networkManager] request', {
    method,
    url,
    viaProxy,
    retry,
    hasBody: body !== null,
    bodyLength: body?.length ?? 0,
    headers: redactHeaders(headers),
  });

  // Backend calls go through the Express proxy, which owns credential injection and the
  // 401 refresh-and-retry. Requests to third-party hosts (presigned upload URLs and the
  // like) are forwarded untouched — attaching the session token to them would leak it.
  if (viaProxy && !headers['client-id']) {
    headers['client-id'] = DEFAULT_CLIENT_ID;
  }

  let response: Response;
  try {
    response = await executeRequest(url, method, headers, body);
  } catch (error) {
    // Offline / DNS failure / timeout — the request never reached the server.
    // Surface a sentinel instead of rejecting so the web layer can treat it as
    // an offline error (not an auth failure → no logout).
    console.warn('[networkManager] request failed (network/timeout)', {
      method,
      url,
      error: String(error),
    });
    return NETWORK_ERROR_RESPONSE;
  }

  console.log('[networkManager] response', {
    method,
    url,
    status_code: response.status,
    ok: response.ok,
    retry,
  });

  return serializeResponse(response);
}

/** True when the request is bound for the main-process Express proxy. */
function isProxyTarget(url: string): boolean {
  try {
    return new URL(url).origin === getApiProxyOrigin();
  } catch {
    return false;
  }
}

export function registerNetworkIpcHandlers(): void {
  ipcMain.handle('network:request', handleNetworkRequest);

  // Inject auth header for all renderer fetch() requests to EKA Care APIs.
  // The SDK (@eka-care/ekascribe-ts-sdk) uses raw fetch(), bypassing the IPC transport that
  // injects auth automatically. Without this, SDK API calls return 403 and trigger auto-logout.
  // The guard prevents double-injection for IPC requests that already carry auth.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://api.eka.care/*', 'https://*.eka.care/*'] },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      if (!requestHeaders['auth'] && !requestHeaders['Auth']) {
        const authToken = getAuthToken();
        if (authToken) {
          requestHeaders['auth'] = authToken;
        }
      }
      callback({ requestHeaders });
    }
  );
}

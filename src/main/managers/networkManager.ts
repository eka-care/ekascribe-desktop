import { ipcMain, net, session } from 'electron';
import { getAuthToken } from './authManager';
import { refreshConnectAuthTokensDeduped } from './connectAuthRefresh';

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
const FLAVOUR = process.platform === 'win32' ? 'ekascribe-desktop-windows' : 'ekascribe-desktop-mac';
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
  const { url, method, headers, body, retry, ekaHost } = payload;
  console.log('[networkManager] request', {
    method,
    url,
    retry,
    hasBody: body !== null,
    bodyLength: body?.length ?? 0,
    headers: redactHeaders(headers),
  });

  if (!headers['auth']) {
    const authToken = getAuthToken();
    if (authToken) {
      headers['auth'] = authToken;
    }
  }

  if (!headers['client-id']) {
    headers['client-id'] = DEFAULT_CLIENT_ID;
  }

  headers['flavour'] = FLAVOUR;

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
    retried: false,
  });

  if (response.status === 401 && retry) {
    const clientId = headers['client-id'] || DEFAULT_CLIENT_ID;
    console.warn('[networkManager] 401 received, attempting refresh+retry', { method, url, clientId });
    const { ok: refreshed } = await refreshConnectAuthTokensDeduped(ekaHost, clientId);
    console.log('[networkManager] refresh result', { method, url, refreshed });

    if (refreshed) {
      const freshToken = getAuthToken();
      if (freshToken) {
        headers['auth'] = freshToken;
      }
      try {
        const retryResponse = await executeRequest(url, method, headers, body);
        return serializeResponse(retryResponse);
      } catch (error) {
        console.warn('[networkManager] retry request failed (network/timeout)', {
          method,
          url,
          error: String(error),
        });
        return NETWORK_ERROR_RESPONSE;
      }
    }
  }

  return serializeResponse(response);
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

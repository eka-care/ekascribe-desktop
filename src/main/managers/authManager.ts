import path from 'node:path';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { app, BrowserWindow, ipcMain, safeStorage, WebContents } from 'electron';
import { IpcMainEvent } from 'electron/main';
import { net, shell } from 'electron';
import ElectronStore from 'electron-store';
import { startEkascribeWeb } from './ekascribeWebManager';
import { captureError, captureLog, addBreadcrumb, identifyUser, resetUser } from './sentryManager';
import { showPermissionPromptIfNeeded } from './notificationManager';
import { clearStorage } from './storageManager';
import { refreshConnectAuthTokensDeduped } from './connectAuthRefresh';
import {
  enterPipMode,
  exitPipModeToRoute,
  sendLoginPipState,
} from './loginWindowManager';

const store = new ElectronStore();
const UNENCRYPTED_PREFIX = 'plain:';
// TODO: enable safeStorage on macOS too — tokens are currently stored as plaintext in electron-store on macOS
const USE_SAFE_STORAGE = process.platform !== 'darwin';
const OIDC_BASE_URL = 'https://aortago.eka.care';
const OIDC_SCOPE = 'openid profile email offline_access';
const OIDC_CALLBACK_PORT = 50515;
const OIDC_REDIRECT_URI = `http://localhost:${OIDC_CALLBACK_PORT}/auth-success`;
const OIDC_CALLBACK_PATHS = new Set(['/auth-success', '/cb']);
const OIDC_CALLBACK_TIMEOUT_MS = 180000;
let activeOidcLoginPromise: Promise<OidcLoginResult> | null = null;
let activeOidcCallbackAbort: ((reason: Error) => void) | null = null;

function logLogin(message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`;
  try {
    const logFilePath = path.join(app.getPath('userData'), 'login.log');
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, line, 'utf8');
  } catch {
    // best-effort file logging only
  }
  console.log(line.trim());
}

type OidcDiscoveryResponse = {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  grant_types_supported?: string[];
};

type OidcClientRegistrationResponse = {
  client_id?: string;
  client_secret?: string;
};

type OidcTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
};

type OidcAuthorizationCallback = {
  code: string;
  state: string;
  scope: string | null;
};

function sanitizeValue(value: string): string {
  return value.replace(/\r?\n/g, '').trim();
}

export type OidcLoginResult = {
  accessToken: string;
  refreshToken: string;
  tokenType: string | null;
  expiresIn: number | null;
  scope: string | null;
  idToken: string | null;
  clientId: string;
  clientSecret: string;
};

export type OidcRefreshResult = {
  accessToken: string;
  refreshToken: string;
  tokenType: string | null;
  expiresIn: number | null;
  scope: string | null;
  idToken: string | null;
};

function setSecret(key: string, value: string): void {
  if (USE_SAFE_STORAGE && safeStorage.isEncryptionAvailable()) {
    store.set(key, safeStorage.encryptString(value).toString('hex'));
  } else {
    store.set(key, UNENCRYPTED_PREFIX + value);
  }
}

function getSecret(key: string): string | null {
  const raw = store.get(key) as string | undefined;
  if (!raw) return null;
  if (raw.startsWith(UNENCRYPTED_PREFIX)) {
    return raw.slice(UNENCRYPTED_PREFIX.length);
  }
  if (!USE_SAFE_STORAGE) {
    // Existing encrypted values were saved when safeStorage was enabled.
    // Skip Keychain decryption on macOS to avoid unlock prompts at startup.
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'hex'));
  } catch (e) {
    captureError(e, { domain: 'auth', component: 'safe_storage', extra: { key } });
    console.error(`Failed to decrypt ${key}`, e);
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function parseJsonResponse(response: Response, operation: string): Promise<unknown> {
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`[oidc] ${operation} failed with status ${response.status}: ${raw}`);
  }

  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`[oidc] ${operation} returned invalid JSON`);
  }
}

async function fetchJson(url: string, operation: string): Promise<unknown> {
  const response = await (net.fetch as Function)(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    bypassCustomProtocolHandlers: true,
  });

  return parseJsonResponse(response, operation);
}

async function postJson(url: string, body: Record<string, unknown>, operation: string): Promise<unknown> {
  const response = await (net.fetch as Function)(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    bypassCustomProtocolHandlers: true,
  });

  return parseJsonResponse(response, operation);
}

async function postForm(url: string, payload: URLSearchParams, operation: string): Promise<unknown> {
  const response = await (net.fetch as Function)(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: payload.toString(),
    bypassCustomProtocolHandlers: true,
  });

  return parseJsonResponse(response, operation);
}

function validateRequiredEndpoint(endpoint: string | undefined, name: string): string {
  if (!endpoint) {
    throw new Error(`[oidc] missing ${name} in discovery response`);
  }
  return endpoint;
}

async function discoverOidcConfiguration(): Promise<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}> {
  const discoveryUrl = `${OIDC_BASE_URL}/oauth2/.well-known/openid-configuration`;
  const response = (await fetchJson(discoveryUrl, 'discovery')) as OidcDiscoveryResponse;
  const authorizationEndpoint = validateRequiredEndpoint(response.authorization_endpoint, 'authorization_endpoint');
  const tokenEndpoint = validateRequiredEndpoint(response.token_endpoint, 'token_endpoint');
  const registrationEndpoint = response.registration_endpoint ?? `${OIDC_BASE_URL}/oauth2/register`;
  const supportedGrants = response.grant_types_supported ?? [];

  if (supportedGrants.length > 0) {
    if (!supportedGrants.includes('authorization_code')) {
      throw new Error('[oidc] authorization_code grant not supported by provider');
    }
    if (!supportedGrants.includes('refresh_token')) {
      throw new Error('[oidc] refresh_token grant not supported by provider');
    }
  }

  return { authorizationEndpoint, tokenEndpoint, registrationEndpoint };
}

async function registerDynamicClient(registrationEndpoint: string): Promise<{ clientId: string; clientSecret: string }> {
  const registrationBody = {
    redirect_uris: [OIDC_REDIRECT_URI],
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: OIDC_SCOPE,
    client_name: 'DeskDocEka Electron',
  };
  const response = (await postJson(registrationEndpoint, registrationBody, 'client registration')) as OidcClientRegistrationResponse;
  const clientId = response.client_id;
  const clientSecret = response.client_secret;

  if (!clientId || !clientSecret) {
    throw new Error('[oidc] registration response missing client credentials');
  }

  return { clientId, clientSecret };
}

function createAuthorizeUrl(authorizationEndpoint: string, clientId: string, state: string, nonce: string): string {
  const authorizeUrl = new URL(authorizationEndpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', OIDC_REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', OIDC_SCOPE);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('nonce', nonce);
  return authorizeUrl.toString();
}

function sendCallbackHtml(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function sendCallbackRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

function parseCallbackRequest(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://localhost:${OIDC_CALLBACK_PORT}`);
}

function parseAuthorizationCallbackFromUrl(parsedUrl: URL, expectedState: string): OidcAuthorizationCallback {
  const code = parsedUrl.searchParams.get('code');
  const state = parsedUrl.searchParams.get('state');
  const scope = parsedUrl.searchParams.get('scope');

  if (!code) {
    throw new Error('[oidc] callback did not include code');
  }
  if (!state || state !== expectedState) {
    throw new Error('[oidc] callback state mismatch');
  }

  return { code, state, scope };
}

async function waitForAuthorizationCode(expectedState: string): Promise<OidcAuthorizationCallback> {
  if (activeOidcCallbackAbort) {
    activeOidcCallbackAbort(new Error('[oidc] previous callback listener aborted by new login attempt'));
  }

  return new Promise((resolve, reject) => {
    let isSettled = false;
    const server = createServer((req, res) => {
      try {
        const parsedUrl = parseCallbackRequest(req);
        logLogin('callback received', {
          method: req.method ?? 'GET',
          path: parsedUrl.pathname,
          state: parsedUrl.searchParams.get('state'),
          scope: parsedUrl.searchParams.get('scope'),
          hasCode: !!parsedUrl.searchParams.get('code'),
          error: parsedUrl.searchParams.get('error'),
          rawUrl: req.url ?? '',
        });
        if (!OIDC_CALLBACK_PATHS.has(parsedUrl.pathname)) {
          sendCallbackHtml(res, 404, '<h3>Invalid callback path</h3>');
          return;
        }

        const error = parsedUrl.searchParams.get('error');
        if (error) {
          const description = parsedUrl.searchParams.get('error_description') ?? 'Authorization failed';
          sendCallbackHtml(res, 400, `<h3>Login failed</h3><p>${description}</p>`);
          cleanup(new Error(`[oidc] authorize error: ${error} (${description})`));
          return;
        }

        let callbackData: OidcAuthorizationCallback;
        try {
          callbackData = parseAuthorizationCallbackFromUrl(parsedUrl, expectedState);
        } catch (parseError) {
          const message = toErrorMessage(parseError);
          if (message.includes('state mismatch')) {
            sendCallbackHtml(res, 400, '<h3>Invalid state</h3>');
          } else {
            sendCallbackHtml(res, 400, '<h3>Missing authorization code</h3>');
          }
          cleanup(new Error(message));
          return;
        }

        logLogin('callback parsed', {
          state: callbackData.state,
          scope: callbackData.scope,
          hasCode: !!callbackData.code,
        });

        sendCallbackRedirect(res, 'ekadoc://');
        cleanup(undefined, callbackData);
      } catch (error) {
        sendCallbackHtml(res, 500, '<h3>Unexpected callback error</h3>');
        cleanup(new Error(`[oidc] callback parsing failed: ${toErrorMessage(error)}`));
      }
    });

    const timer = setTimeout(() => {
      logLogin('callback timeout', { timeoutMs: OIDC_CALLBACK_TIMEOUT_MS });
      cleanup(new Error('[oidc] timeout waiting for authorization callback'));
    }, OIDC_CALLBACK_TIMEOUT_MS);

    const cleanup = (error?: Error, callbackData?: OidcAuthorizationCallback) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      if (activeOidcCallbackAbort === abortListener) {
        activeOidcCallbackAbort = null;
      }
      server.removeAllListeners();
      server.close(() => {
        if (error) {
          reject(error);
          return;
        }
        resolve(callbackData as OidcAuthorizationCallback);
      });
    };
    const abortListener = (reason: Error) => cleanup(reason);
    activeOidcCallbackAbort = abortListener;

    server.on('error', (error) => {
      const message = toErrorMessage(error);
      if (message.includes('EADDRINUSE')) {
        logLogin('callback listener failed EADDRINUSE', { port: OIDC_CALLBACK_PORT });
        cleanup(
          new Error(
            `[oidc] callback listener failed: localhost:${OIDC_CALLBACK_PORT} is already in use. Close the conflicting process or complete/cancel the previous login attempt.`,
          ),
        );
        return;
      }
      logLogin('callback listener failed', { message });
      cleanup(new Error(`[oidc] callback listener failed: ${message}`));
    });

    server.listen(OIDC_CALLBACK_PORT, '127.0.0.1', () => {
      logLogin('callback server listening', { port: OIDC_CALLBACK_PORT });
    });
  });
}

function normalizeTokenResponse(response: OidcTokenResponse): OidcRefreshResult {
  if (!response.access_token || !response.refresh_token) {
    throw new Error('[oidc] token response missing access_token or refresh_token');
  }

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: response.token_type ?? null,
    expiresIn: typeof response.expires_in === 'number' ? response.expires_in : null,
    scope: response.scope ?? null,
    idToken: response.id_token ?? null,
  };
}

async function exchangeAuthorizationCode(
  tokenEndpoint: string,
  payload: { code: string; state: string; scope: string | null; clientId: string; clientSecret: string },
): Promise<OidcRefreshResult> {
  logLogin('exchanging authorization code', {
    tokenEndpoint,
    state: payload.state,
    scope: payload.scope,
    hasCode: !!payload.code,
  });
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: payload.code,
    redirect_uri: OIDC_REDIRECT_URI,
    client_id: sanitizeValue(payload.clientId),
    client_secret: sanitizeValue(payload.clientSecret),
  });
  const response = (await postForm(tokenEndpoint, body, 'authorization_code token exchange')) as OidcTokenResponse;
  return normalizeTokenResponse(response);
}

async function refreshOidcTokenInternal(input: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<OidcRefreshResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: sanitizeValue(input.clientId),
    client_secret: sanitizeValue(input.clientSecret),
  });
  const response = (await postForm(input.tokenEndpoint, body, 'refresh_token exchange')) as OidcTokenResponse;
  const normalized = normalizeTokenResponse(response);

  setSecret('refreshToken', normalized.refreshToken);
  setSecret('authToken', normalized.accessToken);
  return normalized;
}

async function startOidcLogin(): Promise<OidcLoginResult> {
  if (activeOidcLoginPromise) {
    return activeOidcLoginPromise;
  }

  activeOidcLoginPromise = (async () => {
    logLogin('startOidcLogin invoked');
    const { authorizationEndpoint, registrationEndpoint, tokenEndpoint } = await discoverOidcConfiguration();
    logLogin('discovery ok', { authorizationEndpoint, tokenEndpoint, registrationEndpoint });
    const { clientId, clientSecret } = await registerDynamicClient(registrationEndpoint);
    logLogin('client registered', { clientIdLen: clientId.length, hasClientSecret: !!clientSecret });
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const authorizeUrl = createAuthorizeUrl(authorizationEndpoint, clientId, state, nonce);

    const callbackPromise = waitForAuthorizationCode(state);
    logLogin('opening external browser', { authorizeUrl });
    await shell.openExternal(authorizeUrl);
    const callbackData = await callbackPromise;
    const tokenResponse = await exchangeAuthorizationCode(tokenEndpoint, {
      code: callbackData.code,
      state: callbackData.state,
      scope: callbackData.scope,
      clientId,
      clientSecret,
    });
    logLogin('token exchange ok', {
      hasAccessToken: !!tokenResponse.accessToken,
      hasRefreshToken: !!tokenResponse.refreshToken,
      expiresIn: tokenResponse.expiresIn,
    });

    return {
      ...tokenResponse,
      clientId,
      clientSecret,
    };
  })().finally(() => {
    activeOidcLoginPromise = null;
  });

  return activeOidcLoginPromise;
}

async function refreshOidcTokenFromStoredState(): Promise<OidcRefreshResult> {
  const refreshToken = getSecret('refreshToken');
  const clientId = getSecret('oidcClientId');
  const clientSecret = getSecret('oidcClientSecret');

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('[oidc] missing refresh token or client credentials');
  }

  const { tokenEndpoint } = await discoverOidcConfiguration();
  return refreshOidcTokenInternal({ tokenEndpoint, refreshToken, clientId, clientSecret });
}

export function getAuthToken(): string | null {
  return getSecret('authToken');
}

export function getRefreshToken(): string | null {
  return getSecret('refreshToken');
}

export function clearAuthTokens(): void {
  store.delete('refreshToken');
  store.delete('authToken');
}

/** Persists access + refresh from Eka connect-auth refresh-token API (main process store). */
export function persistConnectAuthTokens(accessToken: string, refreshToken: string): void {
  setSecret('authToken', accessToken);
  setSecret('refreshToken', refreshToken);
}

/** Pushes current tokens to all windows so ekascribe-web can refresh `ekascribeSDKConfig` via preload `scribe:setup`. */
export function notifyScribeTokensUpdated(): void {
  const accessToken = getAuthToken();
  const refreshToken = getRefreshToken();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const { webContents } = win;
    if (webContents.isDestroyed()) continue;
    webContents.send('scribe:setup', { accessToken, refreshToken });
  }
}

let _logoutInProgress = false;

export function isLogoutInProgress(): boolean {
  return _logoutInProgress;
}

let isNavigatingToAuthPage = false;

async function loadElectronAuthPage(sender: WebContents): Promise<void> {
  // Prevent concurrent logout navigations from racing and aborting each other.
  if (isNavigatingToAuthPage) return;
  isNavigatingToAuthPage = true;
  try {
    let loaded = false;
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      try {
        await sender.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#/main/`);
        loaded = true;
      } catch (error) {
        console.error('[auth] failed loading Vite dev auth route URL', {
          url: MAIN_WINDOW_VITE_DEV_SERVER_URL,
          error,
        });
      }
      // In dev mode the renderer file doesn't exist — only fall back to it in prod.
      if (!loaded) return;
    }

    if (!loaded) {
      const rendererFilePath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
      await sender.loadFile(rendererFilePath, { hash: '/main/' });
    }
  } finally {
    isNavigatingToAuthPage = false;
  }
}

export function registerAuthIpcHandlers(onAuthStateChanged?: () => void): void {
  ipcMain.on('auth:onAuthSuccess', (event: IpcMainEvent, refreshToken: string, authToken: string) => {
    _logoutInProgress = false;
    logLogin('ipc auth:onAuthSuccess received', {
      hasAccessToken: !!authToken,
      hasRefreshToken: !!refreshToken,
    });
    setSecret('refreshToken', refreshToken);
    setSecret('authToken', authToken);
    onAuthStateChanged?.();
    const persistedAccessToken = getAuthToken();
    const persistedRefreshToken = getRefreshToken();
    logLogin('tokens persisted', {
      hasPersistedAccess: Boolean(persistedAccessToken),
      hasPersistedRefresh: Boolean(persistedRefreshToken),
    });
    captureLog('login_completed', { method: 'oidc' });
    try {
      const payload = JSON.parse(atob(authToken.split('.')[1]));
      if (payload.sub) identifyUser(payload.sub);
    } catch { /* best-effort user identification */ }
    void (async () => {
      try {
        logLogin('starting ekascribe-web');
        const ekascribeWebUrl = await startEkascribeWeb();
        logLogin('ekascribe-web started', { url: ekascribeWebUrl });
        if (!event.sender.isDestroyed()) {
          event.sender.once('did-finish-load', () => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('scribe:setup', {
                accessToken: persistedAccessToken,
                refreshToken: persistedRefreshToken,
              });
            }
          });
          logLogin('loading ekascribe-web url', { url: ekascribeWebUrl });
          await event.sender.loadURL(ekascribeWebUrl);
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win && !win.isDestroyed()) {
            // Force macOS to repaint after PiP → fullsize + loadURL transition.
            win.blur();
            win.focus();
            setTimeout(() => {
              if (!win.isDestroyed()) {
                showPermissionPromptIfNeeded(win);
              }
            }, 1500);
          }
        }
      } catch (error) {
        captureError(error, { domain: 'auth', component: 'ekascribe_web_start' });
      }
    })();
  });

  ipcMain.handle('auth:getRefreshToken', () => getRefreshToken());

  ipcMain.handle('auth:getAuthToken', () => getAuthToken());

  ipcMain.handle('auth:getTokens', () => ({
    authToken: getAuthToken(),
    refreshToken: getRefreshToken(),
  }));

  ipcMain.on('auth:getTokensSync', (event) => {
    event.returnValue = {
      authToken: getAuthToken(),
      refreshToken: getRefreshToken(),
    };
  });

  // Sync tokens from a renderer-side refresh into the main-process store so
  // networkManager and any other main-side getAuthToken() callers stay fresh.
  // No navigation, unlike auth:onAuthSuccess.
  ipcMain.handle('auth:persistTokens', (_event, accessToken: string, refreshToken: string) => {
    logLogin('ipc auth:persistTokens received', {
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
    });
    if (accessToken && refreshToken) {
      persistConnectAuthTokens(accessToken, refreshToken);
      notifyScribeTokensUpdated();
    }
  });

  // Renderer-initiated refresh that shares one in-flight refresh promise with
  // networkManager. Prevents simultaneous refresh POSTs racing for the same
  // single-use refresh token (which produces 403 + forced logout).
  ipcMain.handle('auth:refreshConnectToken', async (_event, ekaHost: string) => {
    logLogin('ipc auth:refreshConnectToken start', { ekaHost });
    const { ok: refreshed, isNetworkError } = await refreshConnectAuthTokensDeduped(ekaHost, 'doc-web');
    logLogin('ipc auth:refreshConnectToken result', {
      refreshed,
      isNetworkError,
      hasAuthToken: !!getAuthToken(),
      hasRefreshToken: !!getRefreshToken(),
    });
    return {
      refreshed,
      isNetworkError,
      authToken: getAuthToken(),
      refreshToken: getRefreshToken(),
    };
  });

  ipcMain.handle('auth:startOidcLogin', async (event) => {
    logLogin('ipc auth:startOidcLogin start');
    addBreadcrumb('auth', 'login_initiated', { method: 'oidc' });

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      enterPipMode(win);
      sendLoginPipState({ type: 'waiting' });
    }

    try {
      const result = await startOidcLogin();
      setSecret('oidcClientId', sanitizeValue(result.clientId));
      setSecret('oidcClientSecret', sanitizeValue(result.clientSecret));
      logLogin('ipc auth:startOidcLogin ok', {
        hasAccess: !!result.accessToken,
        hasRefresh: !!result.refreshToken,
      });
      // Restore window bounds before onAuthSuccess loads ekascribe-web
      exitPipModeToRoute('/main/');
      return result;
    } catch (e) {
      logLogin('ipc auth:startOidcLogin FAILED', { error: toErrorMessage(e) });
      captureError(e, { domain: 'auth', component: 'oidc', extra: { step: 'login' } });
      const message = toErrorMessage(e);
      sendLoginPipState({ type: 'error', message });
      setTimeout(() => exitPipModeToRoute('/main/'), 3000);
      throw e;
    }
  });

  ipcMain.on('login-pip:cancel', () => {
    activeOidcCallbackAbort?.(new Error('Login cancelled by user'));
    exitPipModeToRoute('/main/');
  });

  ipcMain.handle('auth:refreshOidcToken', async () => {
    logLogin('ipc auth:refreshOidcToken start');
    try {
      const result = await refreshOidcTokenFromStoredState();
      logLogin('ipc auth:refreshOidcToken ok', { hasAccessToken: !!result.accessToken });
      return result;
    } catch (e) {
      logLogin('ipc auth:refreshOidcToken FAILED', { error: toErrorMessage(e) });
      throw e;
    }
  });

  ipcMain.handle('log:write', (_event, message: string) => {
    logLogin(message);
  });

  ipcMain.handle('auth:logout', async (event) => {
    _logoutInProgress = true;
    addBreadcrumb('auth', 'logout');
    resetUser();
    clearAuthTokens();
    onAuthStateChanged?.();
    store.delete('oidcClientId');
    store.delete('oidcClientSecret');
    await clearStorage();
    if (!event.sender.isDestroyed()) {
      await loadElectronAuthPage(event.sender);
    }
  });
}

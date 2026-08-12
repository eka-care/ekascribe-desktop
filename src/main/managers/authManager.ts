import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain, safeStorage, WebContents } from 'electron';
import { IpcMainEvent } from 'electron/main';
import ElectronStore from 'electron-store';
import { startEkascribeWeb, getEkascribeAppOrigin } from './ekascribeWebManager';
import { showPermissionPromptIfNeeded } from './notificationManager';
import { clearStorage } from './storageManager';
import { refreshConnectAuthTokensDeduped } from './connectAuthRefresh';
import { startDeviceLogin, cancelDeviceLogin } from './deviceLoginManager';
import {
  enterPipMode,
  exitPipModeToRoute,
  sendLoginPipState,
} from './loginWindowManager';
import { FORCE_AUTHENTICATED } from '../config';

const store = new ElectronStore();
const UNENCRYPTED_PREFIX = 'plain:';
// TODO: enable safeStorage on macOS too — tokens are currently stored as plaintext in electron-store on macOS
const USE_SAFE_STORAGE = process.platform !== 'darwin';

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
    console.error(`Failed to decrypt ${key}`, e);
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  // Chokepoint for every navigation to the native login screen — hard-stop under FORCE_AUTH
  // so no current or future caller can bounce a forced session back to auth.
  if (FORCE_AUTHENTICATED) {
    console.warn('[auth] FORCE_AUTH — suppressing navigation to login screen');
    return;
  }
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
    void (async () => {
      try {
        logLogin('starting ekascribe-web');
        await startEkascribeWeb();
        // The `app://` origin, not the loopback server behind it — see ekascribeWebManager.
        const ekascribeWebUrl = getEkascribeAppOrigin();
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
        console.error('[auth] failed starting ekascribe-web after login', error);
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

  ipcMain.handle('auth:startLogin', async (event) => {
    logLogin('ipc auth:startLogin start');

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      enterPipMode(win);
      sendLoginPipState({ type: 'waiting' });
    }

    try {
      // The code arrives well before the tokens do — push it straight to the PIP
      // panel so the user can act on it while polling continues underneath.
      const result = await startDeviceLogin((code) => {
        sendLoginPipState({
          type: 'code',
          userCode: code.userCode,
          verificationUrl: code.verificationUrl,
          expiresAt: code.expiresAt,
        });
      });
      logLogin('ipc auth:startLogin ok', {
        hasAccess: !!result.accessToken,
        hasRefresh: !!result.refreshToken,
      });
      // Restore window bounds before onAuthSuccess loads ekascribe-web
      exitPipModeToRoute('/main/');
      return result;
    } catch (e) {
      logLogin('ipc auth:startLogin FAILED', { error: toErrorMessage(e) });
      const message = toErrorMessage(e);
      sendLoginPipState({ type: 'error', message });
      setTimeout(() => exitPipModeToRoute('/main/'), 3000);
      throw e;
    }
  });

  ipcMain.on('login-pip:cancel', () => {
    cancelDeviceLogin(new Error('Login cancelled by user'));
    exitPipModeToRoute('/main/');
  });

  ipcMain.handle('log:write', (_event, message: string) => {
    logLogin(message);
  });

  ipcMain.handle('auth:logout', async (event) => {
    if (FORCE_AUTHENTICATED) {
      console.warn('[auth] FORCE_AUTH — ignoring logout request');
      return;
    }
    _logoutInProgress = true;
    clearAuthTokens();
    onAuthStateChanged?.();
    await clearStorage();
    if (!event.sender.isDestroyed()) {
      await loadElectronAuthPage(event.sender);
    }
  });
}

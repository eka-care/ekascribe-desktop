import { BrowserWindow, ipcMain, Notification, shell } from 'electron';
import ElectronStore from 'electron-store';

const store = new ElectronStore();
const SESSION_COUNT_KEY = 'notification.sessionCount';
const NEVER_ASK_KEY = 'notification.neverAsk';
const SHOW_EVERY_N_SESSIONS = 3;

let permissionPromptWindow: BrowserWindow | null = null;
let shownThisSession = false;

export interface ShowNotificationOptions {
  title: string;
  body: string;
  silent?: boolean;
  icon?: string;
  data?: Record<string, unknown>;
  force?: boolean;
}

let activeNotifications: Notification[] = [];

export function showNotification(opts: ShowNotificationOptions): void {
  if (!Notification.isSupported()) return;
  if (!opts.force && BrowserWindow.getFocusedWindow() !== null) return;
  const n = new Notification({
    title: opts.title,
    body: opts.body,
    silent: opts.silent ?? false,
    ...(opts.icon ? { icon: opts.icon } : {}),
  });

  activeNotifications.push(n);

  const cleanup = () => {
    activeNotifications = activeNotifications.filter((notif) => notif !== n);
  };

  n.on('close', cleanup);
  n.on('click', () => {
    cleanup();
    ipcMain.emit('scribe:notification-clicked', null, opts.data ?? null);
  });
  n.show();
}

function getPermissionPromptHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Enable Notifications</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif;
        background: #ffffff;
        color: #111827;
        height: 100vh;
        overflow: hidden;
      }
      .wrap {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        height: 100%;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        background: #ffffff;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      }
      .header {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .icon { font-size: 18px; }
      .title {
        font-size: 13px;
        font-weight: 600;
        color: #111827;
      }
      .body {
        font-size: 12px;
        color: #6b7280;
        line-height: 1.5;
      }
      .actions {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 2px;
      }
      button {
        border: none;
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
        transition: opacity 0.1s;
      }
      button:hover { opacity: 0.85; }
      #allow { background: #2563eb; color: #ffffff; }
      #deny { background: #f3f4f6; color: #374151; }
      #neverAsk { background: transparent; color: #9ca3af; font-size: 11px; padding: 4px 12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <span class="icon">🔔</span>
        <span class="title">Stay in the loop</span>
      </div>
      <div class="body">Allow EkaScribe to notify you when your session analysis is ready or a prescription has been sent.</div>
      <div class="actions">
        <button id="allow">Allow Notifications</button>
        <button id="deny">Not Now</button>
        <button id="neverAsk">Don't ask again</button>
      </div>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
      document.getElementById('allow').addEventListener('click', () => {
        ipcRenderer.send('notification-prompt:action', 'allow');
      });
      document.getElementById('deny').addEventListener('click', () => {
        ipcRenderer.send('notification-prompt:action', 'deny');
      });
      document.getElementById('neverAsk').addEventListener('click', () => {
        ipcRenderer.send('notification-prompt:action', 'neverAsk');
      });
    </script>
  </body>
</html>`;
}

function positionPermissionPrompt(hostWindow: BrowserWindow): void {
  if (!permissionPromptWindow || permissionPromptWindow.isDestroyed() || hostWindow.isDestroyed()) return;
  const hostBounds = hostWindow.getBounds();
  const [width, height] = permissionPromptWindow.getSize();
  permissionPromptWindow.setBounds({
    x: hostBounds.x + hostBounds.width - width - 16,
    y: hostBounds.y + 60,
    width,
    height,
  });
}

export async function showPermissionPromptIfNeeded(win: BrowserWindow): Promise<void> {
  if (process.platform !== 'darwin') return;

  if (shownThisSession) return;
  shownThisSession = true;

  if (store.get(NEVER_ASK_KEY)) return;

  try {
    const permission = await win.webContents.executeJavaScript('Notification.permission');
    if (permission === 'granted') {
      store.set(NEVER_ASK_KEY, true);
      return;
    }
  } catch (error) {
    console.error('Failed to check native notification permission:', error);
  }

  const sessionCount = ((store.get(SESSION_COUNT_KEY) as number) ?? 0) + 1;
  store.set(SESSION_COUNT_KEY, sessionCount);

  if (sessionCount % SHOW_EVERY_N_SESSIONS !== 1) return;

  if (win.isDestroyed()) return;

  if (permissionPromptWindow && !permissionPromptWindow.isDestroyed()) {
    positionPermissionPrompt(win);
    permissionPromptWindow.show();
    permissionPromptWindow.focus();
    return;
  }

  const width = 300;
  const height = 210;
  const hostBounds = win.getBounds();

  permissionPromptWindow = new BrowserWindow({
    width,
    height,
    x: hostBounds.x + hostBounds.width - width - 16,
    y: hostBounds.y + 60,
    parent: win,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  permissionPromptWindow.on('closed', () => {
    permissionPromptWindow = null;
  });

  const html = getPermissionPromptHtml();
  void permissionPromptWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  permissionPromptWindow.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      positionPermissionPrompt(win);
    }
    permissionPromptWindow?.show();
  });
}

export function registerNotificationIpcHandlers(): void {
  ipcMain.handle('notification:show', (_e, opts: ShowNotificationOptions) => {
    showNotification({ ...opts, force: true });
  });

  ipcMain.on('notification-prompt:action', (_event, action: 'allow' | 'deny' | 'neverAsk') => {
    permissionPromptWindow?.close();
    permissionPromptWindow = null;

    if (action === 'allow') {
      store.set(NEVER_ASK_KEY, true);
      showNotification({
        title: 'EkaScribe',
        body: 'Enable notifications in System Settings to receive updates on your sessions.',
      });
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications');
    } else if (action === 'neverAsk') {
      store.set(NEVER_ASK_KEY, true);
    }
    // 'deny': close only — will re-prompt after SHOW_EVERY_N_SESSIONS sessions
  });
}

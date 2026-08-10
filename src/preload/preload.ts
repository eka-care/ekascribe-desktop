// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type ScribeCommand = 'start' | 'pause' | 'resume' | 'stop';
type ScribeSetupPayload = { accessToken: string | null; refreshToken?: string | null };

const scribeCommandSubscribers: Record<ScribeCommand, Set<() => void>> = {
  start: new Set(),
  pause: new Set(),
  resume: new Set(),
  stop: new Set(),
};

const pendingScribeCommandCount: Record<ScribeCommand, number> = {
  start: 0,
  pause: 0,
  resume: 0,
  stop: 0,
};
const scribeSetupSubscribers = new Set<(payload: ScribeSetupPayload) => void>();
let latestScribeSetupPayload: ScribeSetupPayload | null = null;

function runScribeSubscriber(command: ScribeCommand, subscriber: () => void): void {
  try {
    subscriber();
    ipcRenderer.send('scribe:command-consumed', command);
  } catch {
    // best-effort dispatch only
  }
}

function dispatchOrQueueScribeCommand(command: ScribeCommand): void {
  const subscribers = scribeCommandSubscribers[command];
  if (subscribers.size === 0) {
    pendingScribeCommandCount[command] += 1;
    return;
  }
  for (const subscriber of subscribers) {
    runScribeSubscriber(command, subscriber);
  }
}

function subscribeToScribeCommand(command: ScribeCommand, callback: () => void): () => void {
  const subscribers = scribeCommandSubscribers[command];
  subscribers.add(callback);

  const pendingCount = pendingScribeCommandCount[command];
  if (pendingCount > 0) {
    pendingScribeCommandCount[command] = 0;
    for (let idx = 0; idx < pendingCount; idx += 1) {
      runScribeSubscriber(command, callback);
    }
  }

  return () => {
    subscribers.delete(callback);
  };
}

ipcRenderer.on('scribe:start', () => dispatchOrQueueScribeCommand('start'));
ipcRenderer.on('scribe:pause', () => dispatchOrQueueScribeCommand('pause'));
ipcRenderer.on('scribe:resume', () => dispatchOrQueueScribeCommand('resume'));
ipcRenderer.on('scribe:stop', () => dispatchOrQueueScribeCommand('stop'));
ipcRenderer.on('scribe:setup', (_event: IpcRendererEvent, payload: ScribeSetupPayload) => {
  latestScribeSetupPayload = payload;
  if (scribeSetupSubscribers.size === 0) {
    return;
  }
  for (const subscriber of scribeSetupSubscribers) {
    subscriber(payload);
  }
});

let initialTokens: { authToken: string | null; refreshToken: string | null } = {
  authToken: null,
  refreshToken: null,
};
try {
  const result = ipcRenderer.sendSync('auth:getTokensSync');
  if (result && typeof result === 'object') {
    initialTokens = {
      authToken: result.authToken ?? null,
      refreshToken: result.refreshToken ?? null,
    };
  }
} catch {
  // best-effort sync read; async getTokens() remains available as fallback
}

contextBridge.exposeInMainWorld('authApi', {
  initialTokens,
  onAuthSuccess: (refreshToken: string, authToken: string) => ipcRenderer.send('auth:onAuthSuccess', refreshToken, authToken),
  getRefreshToken: () => ipcRenderer.invoke('auth:getRefreshToken'),
  getAuthToken: () => ipcRenderer.invoke('auth:getAuthToken'),
  getTokens: () => ipcRenderer.invoke('auth:getTokens'),
  startOidcLogin: () => ipcRenderer.invoke('auth:startOidcLogin'),
  refreshOidcToken: () => ipcRenderer.invoke('auth:refreshOidcToken'),
  persistTokens: (accessToken: string, refreshToken: string) =>
    ipcRenderer.invoke('auth:persistTokens', accessToken, refreshToken),
  refreshConnectToken: (ekaHost: string) =>
    ipcRenderer.invoke('auth:refreshConnectToken', ekaHost),
  logout: () => ipcRenderer.invoke('auth:logout'),
})

contextBridge.exposeInMainWorld('recordingApi', {
  startSystemAudio: () => ipcRenderer.invoke('recording:start'),
  stopSystemAudio: () => ipcRenderer.invoke('recording:stop'),
});

contextBridge.exposeInMainWorld('scribeApi', {
  onStartRequest: (callback: () => void) => {
    return subscribeToScribeCommand('start', callback);
  },
  onPauseRequest: (callback: () => void) => {
    return subscribeToScribeCommand('pause', callback);
  },
  onResumeRequest: (callback: () => void) => {
    return subscribeToScribeCommand('resume', callback);
  },
  onStopRequest: (callback: () => void) => {
    return subscribeToScribeCommand('stop', callback);
  },
  onSetupScribeApp: (callback: (payload: ScribeSetupPayload) => void) => {
    scribeSetupSubscribers.add(callback);
    if (latestScribeSetupPayload) {
      callback(latestScribeSetupPayload);
    }
    return () => scribeSetupSubscribers.delete(callback);
  },
  updateStatus: (processingStatus: string, sessionId: string | null) => {
    ipcRenderer.send('scribe:statusUpdate', processingStatus, sessionId);
  },
  onGetStatusRequest: (callback: () => { processingStatus: string; sessionId: string }) => {
    const handler = (_event: IpcRendererEvent, requestId: string) => {
      try {
        const status = callback();
        ipcRenderer.send('scribe:get-status-reply', requestId, status);
      } catch {
        ipcRenderer.send('scribe:get-status-reply', requestId, { processingStatus: 'not-started', sessionId: '' });
      }
    };
    ipcRenderer.on('scribe:get-status', handler);
    return () => ipcRenderer.removeListener('scribe:get-status', handler);
  },
  onViewTransaction: (callback: (transactionId: string) => void) => {
    const handler = (_event: IpcRendererEvent, transactionId: string) => callback(transactionId);
    ipcRenderer.on('scribe:view-transaction', handler);
    return () => ipcRenderer.removeListener('scribe:view-transaction', handler);
  },
  notifyProcessingCompleted: (transactionId: string, status: string) => {
    ipcRenderer.send('scribe:processingCompleted', transactionId, status);
  },
  notifySessionDiscarded: () => {
    ipcRenderer.send('scribe:session-discarded');
  },
  notifyError: (errorCode: string, errorMessage: string) => {
    ipcRenderer.send('scribe:error', errorCode, errorMessage);
  },
  notifyRendererReady: () => {
    ipcRenderer.send('scribe:renderer-ready');
  },
  sendAppointments: (data: unknown) => {
    ipcRenderer.send('scribe:appointments-update', data);
  },
  onStartWithAppointmentRequest: (callback: (data: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('scribe:start-with-appointment', handler);
    return () => ipcRenderer.removeListener('scribe:start-with-appointment', handler);
  },
});

contextBridge.exposeInMainWorld('ekascribeWebApi', {
  start: () => ipcRenderer.invoke('ekascribe-web:start'),
  stop: () => ipcRenderer.invoke('ekascribe-web:stop'),
  getUrl: () => ipcRenderer.invoke('ekascribe-web:url'),
});

contextBridge.exposeInMainWorld('networkApi', {
  request: (payload: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    retry: boolean;
    ekaHost: string;
  }) => ipcRenderer.invoke('network:request', payload),
});

contextBridge.exposeInMainWorld('deepLinkApi', {
  onDeepLink: (callback: (url: string) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { url: string }) => callback(payload.url);
    ipcRenderer.on('app:deep-link', handler);
    return () => ipcRenderer.removeListener('app:deep-link', handler);
  },
});

contextBridge.exposeInMainWorld('printApi', {
  htmlToPdf: (html: string) => ipcRenderer.invoke('print:htmlToPdf', html),
});

contextBridge.exposeInMainWorld('logApi', {
  log: (message: string) => ipcRenderer.invoke('log:write', message),
});

const appVersion: string = ipcRenderer.sendSync('app:getVersionSync') ?? '';

contextBridge.exposeInMainWorld('systemApi', {
  appVersion,
  getDotnetRuntimeStatus: (options?: { refresh?: boolean }) => ipcRenderer.invoke('system:getDotnetRuntimeStatus', options),
  openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url),
  onOpenUserDefaults: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:open-user-defaults', handler);
    return () => ipcRenderer.removeListener('app:open-user-defaults', handler);
  },
  onLogout: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:logout', handler);
    return () => ipcRenderer.removeListener('app:logout', handler);
  },
});

type WhatsAppAutoSendPreferences = {
  send_via_linked_device: boolean;
  auto_send_rate_limit: number;
  allow_partner_emr_auto_send: boolean;
};

type OverlayNotificationPreferences = {
  joinVideoConferencingAndStartTranscribing: boolean;
  meetingIsBeingRecorded: boolean;
  meetingIsSummarized: boolean;
};

type OverlayShortcutPreferences = {
  enabled: boolean;
  shortcut: string;
};

// --- WhatsApp integration ---

const whatsappQrSubscribers = new Set<(qr: string) => void>();
const whatsappStatusSubscribers = new Set<(status: string) => void>();
let latestWhatsappQr: string | null = null;
let latestWhatsappStatus: string | null = null;

ipcRenderer.on('whatsapp:qr-update', (_event: IpcRendererEvent, qr: string) => {
  latestWhatsappQr = qr;
  for (const subscriber of whatsappQrSubscribers) {
    subscriber(qr);
  }
});

ipcRenderer.on('whatsapp:status-change', (_event: IpcRendererEvent, status: string) => {
  latestWhatsappStatus = status;
  if (status === 'disconnected') {
    latestWhatsappQr = null;
  }
  for (const subscriber of whatsappStatusSubscribers) {
    subscriber(status);
  }
});

contextBridge.exposeInMainWorld('whatsappApi', {
  connect: () => ipcRenderer.invoke('whatsapp:connect'),
  disconnect: () => ipcRenderer.invoke('whatsapp:disconnect'),
  getStatus: () => ipcRenderer.invoke('whatsapp:status'),
  sendDocument: (payload: { phoneNumber: string; pdfBuffer: ArrayBuffer; fileName: string; caption?: string }) =>
    ipcRenderer.invoke('whatsapp:send-document', payload),
  onQrCode: (callback: (qr: string) => void) => {
    whatsappQrSubscribers.add(callback);
    if (latestWhatsappQr) callback(latestWhatsappQr);
    return () => { whatsappQrSubscribers.delete(callback); };
  },
  onStatusChange: (callback: (status: string) => void) => {
    whatsappStatusSubscribers.add(callback);
    if (latestWhatsappStatus) callback(latestWhatsappStatus);
    return () => { whatsappStatusSubscribers.delete(callback); };
  },
});

contextBridge.exposeInMainWorld('notificationApi', {
  show: (opts: { title: string; body: string; silent?: boolean }) =>
    ipcRenderer.invoke('notification:show', opts),
  onClick: (callback: (data: Record<string, unknown> | null) => void) => {
    const handler = (_event: IpcRendererEvent, data: Record<string, unknown> | null) => callback(data);
    ipcRenderer.on('notification:clicked', handler);
    return () => ipcRenderer.removeListener('notification:clicked', handler);
  },
});

contextBridge.exposeInMainWorld('clipboardApi', {
  write: (payload: { html?: string; text: string }) =>
    ipcRenderer.invoke('clipboard:write', payload),
});

contextBridge.exposeInMainWorld('fileApi', {
  openFile: (options?: { type?: 'document' | 'audio'; accept?: string; multiple?: boolean }) =>
    ipcRenderer.invoke('dialog:open-file', options ?? { type: 'document' }),
});

contextBridge.exposeInMainWorld('blobApi', {
  put: (txnId: string, fileName: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('storage:saveAudio', txnId, fileName, data),
  get: (txnId: string, fileName: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('storage:fetchAudio', txnId, fileName),
  list: (txnId: string): Promise<string[]> =>
    ipcRenderer.invoke('storage:listFiles', txnId),
  delete: (txnId: string, fileName?: string): Promise<void> =>
    ipcRenderer.invoke('storage:deleteAll'),
});

let latestUpdateInfo: { version: string } | null = null;
let latestUpdateReady = false;

ipcRenderer.on('desktop:update-available', (_event: IpcRendererEvent, info: { version: string }) => {
  ipcRenderer.send('updater:log', '[preload] desktop:update-available received', info);
  latestUpdateInfo = info;
});
ipcRenderer.on('desktop:update-ready', () => {
  ipcRenderer.send('updater:log', '[preload] desktop:update-ready received');
  latestUpdateReady = true;
});

contextBridge.exposeInMainWorld('desktopSettingsApi', {
  getNotificationPreferences: (): Promise<OverlayNotificationPreferences> =>
    ipcRenderer.invoke('desktop:notification-prefs:get'),
  updateNotificationPreferences: (
    prefs: Partial<OverlayNotificationPreferences>,
  ): Promise<OverlayNotificationPreferences> =>
    ipcRenderer.invoke('desktop:notification-prefs:update', prefs),
  getShortcutPreferences: (): Promise<OverlayShortcutPreferences> =>
    ipcRenderer.invoke('desktop:shortcut-prefs:get'),
  updateShortcutPreferences: (
    prefs: Partial<OverlayShortcutPreferences>,
  ): Promise<OverlayShortcutPreferences> =>
    ipcRenderer.invoke('desktop:shortcut-prefs:update', prefs),
  getWhatsAppAutoSendPrefs: (): Promise<WhatsAppAutoSendPreferences> =>
    ipcRenderer.invoke('desktop:whatsapp-auto-send-prefs:get'),
  updateWhatsAppAutoSendPrefs: (
    prefs: Partial<WhatsAppAutoSendPreferences>,
  ): Promise<WhatsAppAutoSendPreferences> =>
    ipcRenderer.invoke('desktop:whatsapp-auto-send-prefs:update', prefs),
  onWhatsAppPrefsUpdated: (callback: (prefs: WhatsAppAutoSendPreferences) => void): () => void => {
    const handler = (_event: IpcRendererEvent, prefs: WhatsAppAutoSendPreferences) => callback(prefs);
    ipcRenderer.on('desktop:whatsapp-prefs-updated', handler);
    return () => ipcRenderer.removeListener('desktop:whatsapp-prefs-updated', handler);
  },
  onUpdateAvailable: (callback: (info: { version: string }) => void): () => void => {
    ipcRenderer.send('updater:log', '[preload] onUpdateAvailable registered', { latestUpdateInfo });
    if (latestUpdateInfo) {
      ipcRenderer.send('updater:log', '[preload] replaying latestUpdateInfo', latestUpdateInfo);
      callback(latestUpdateInfo);
    }
    const handler = (_event: IpcRendererEvent, info: { version: string }) => {
      ipcRenderer.send('updater:log', '[preload] desktop:update-available forwarded to renderer', info);
      callback(info);
    };
    ipcRenderer.on('desktop:update-available', handler);
    return () => ipcRenderer.removeListener('desktop:update-available', handler);
  },
  onUpdateProgress: (callback: (info: { percent: number }) => void): () => void => {
    const handler = (_event: IpcRendererEvent, info: { percent: number }) => callback(info);
    ipcRenderer.on('desktop:update-progress', handler);
    return () => ipcRenderer.removeListener('desktop:update-progress', handler);
  },
  onUpdateReady: (callback: () => void): () => void => {
    ipcRenderer.send('updater:log', '[preload] onUpdateReady registered', { latestUpdateReady });
    if (latestUpdateReady) {
      ipcRenderer.send('updater:log', '[preload] replaying latestUpdateReady');
      callback();
    }
    const handler = () => {
      ipcRenderer.send('updater:log', '[preload] desktop:update-ready forwarded to renderer');
      callback();
    };
    ipcRenderer.on('desktop:update-ready', handler);
    return () => ipcRenderer.removeListener('desktop:update-ready', handler);
  },
  relaunchAndInstall: (): Promise<void> => ipcRenderer.invoke('desktop:relaunch-and-install'),
  logDebug: (message: string, meta?: unknown): void => {
    ipcRenderer.send('updater:log', message, meta);
  },
  getAutoLaunchPref: (): Promise<boolean> =>
    ipcRenderer.invoke('desktop:auto-launch:get'),
  setAutoLaunchPref: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('desktop:auto-launch:update', enabled),
});

contextBridge.exposeInMainWorld('loginPipApi', {
  onEnter: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('login-pip:enter', handler);
    return () => ipcRenderer.removeListener('login-pip:enter', handler);
  },
  onExit: (callback: (route: string) => void) => {
    const handler = (_event: IpcRendererEvent, route: string) => callback(route);
    ipcRenderer.on('login-pip:exit', handler);
    return () => ipcRenderer.removeListener('login-pip:exit', handler);
  },
  onState: (callback: (state: { type: 'waiting' } | { type: 'error'; message: string }) => void) => {
    const handler = (_event: IpcRendererEvent, state: { type: 'waiting' } | { type: 'error'; message: string }) =>
      callback(state);
    ipcRenderer.on('login-pip:state', handler);
    return () => ipcRenderer.removeListener('login-pip:state', handler);
  },
  cancelLogin: () => ipcRenderer.send('login-pip:cancel'),
});

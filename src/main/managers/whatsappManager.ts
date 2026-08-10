import { app, BrowserWindow, ipcMain } from 'electron';
import { showNotification } from './notificationManager';
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { captureError } from './sentryManager';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const baileysModule = require('@whiskeysockets/baileys');

console.log('[whatsappManager] baileysModule type:', typeof baileysModule);
console.log('[whatsappManager] baileysModule.default type:', typeof baileysModule.default);
console.log('[whatsappManager] baileysModule.makeWASocket type:', typeof baileysModule.makeWASocket);
console.log('[whatsappManager] baileysModule.useMultiFileAuthState type:', typeof baileysModule.useMultiFileAuthState);
console.log('[whatsappManager] baileysModule.Browsers type:', typeof baileysModule.Browsers);
console.log('[whatsappManager] baileysModule.DisconnectReason type:', typeof baileysModule.DisconnectReason);

const makeWASocket: typeof baileysModule.default = baileysModule.default || baileysModule.makeWASocket;
const useMultiFileAuthState: typeof baileysModule.useMultiFileAuthState = baileysModule.useMultiFileAuthState;
const fetchLatestBaileysVersion: typeof baileysModule.fetchLatestBaileysVersion = baileysModule.fetchLatestBaileysVersion;
const Browsers: typeof baileysModule.Browsers = baileysModule.Browsers;
const DisconnectReason: typeof baileysModule.DisconnectReason = baileysModule.DisconnectReason;

console.log('[whatsappManager] resolved makeWASocket type:', typeof makeWASocket);

type WASocket = ReturnType<typeof makeWASocket>;

let sock: WASocket | null = null;
let connectionStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
let currentQrCode: string | null = null;
let connectedPhoneNumber: string | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function getAuthDir(): string {
  return path.join(app.getPath('userData'), 'whatsapp-auth');
}

function phoneToJid(phoneNumber: string): string {
  const cleaned = phoneNumber.replace(/[\s\-\+\(\)]/g, '');
  const withCountryCode = cleaned.length === 10 ? `91${cleaned}` : cleaned;
  return `${withCountryCode}@s.whatsapp.net`;
}

function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  }
}

function broadcastStatusChange(): void {
  console.log('[whatsappManager] status changed:', connectionStatus);
  broadcastToAllWindows('whatsapp:status-change', connectionStatus);
}

function getBrowserConfig(name = 'EkaScribe') {
  return [name, name, name]
}

async function connectWhatsApp(): Promise<void> {
  console.log('[whatsappManager] connectWhatsApp called, current status:', connectionStatus);
  if (connectionStatus === 'connected' || connectionStatus === 'connecting') return;

  connectionStatus = 'connecting';
  broadcastStatusChange();

  const authDir = getAuthDir();
  console.log('[whatsappManager] auth dir:', authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  console.log('[whatsappManager] auth state loaded');

  let version: number[] | undefined;
  try {
    const versionResult = await fetchLatestBaileysVersion();
    version = versionResult.version;
    console.log('[whatsappManager] fetched latest WA version:', version, 'isLatest:', versionResult.isLatest);
  } catch (err) {
    console.warn('[whatsappManager] failed to fetch latest version, using default:', err);
  }

  console.log('[whatsappManager] creating socket...');
  sock = makeWASocket({
    auth: state,
    browser: getBrowserConfig(),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    ...(version ? { version } : {}),
  });
  console.log('[whatsappManager] socket created');

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update: any) => {
    const { qr, connection, lastDisconnect } = update;
    console.log('[whatsappManager] connection.update:', { qr: !!qr, connection, lastDisconnect: !!lastDisconnect });

    if (qr) {
      currentQrCode = qr;
      console.log('[whatsappManager] QR code received, broadcasting...');
      broadcastToAllWindows('whatsapp:qr-update', qr);
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      currentQrCode = null;
      reconnectAttempts = 0;
      const userJid = sock?.user?.id;
      if (userJid) {
        const rawPhone = userJid.split(':')[0].split('@')[0];
        connectedPhoneNumber = `+${rawPhone}`;
      }
      console.log('[whatsappManager] connected successfully, phone:', connectedPhoneNumber);
      broadcastStatusChange();
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      console.log('[whatsappManager] connection closed, statusCode:', statusCode);
      connectionStatus = 'disconnected';
      currentQrCode = null;
      connectedPhoneNumber = null;
      const wasLoggedOut = statusCode === DisconnectReason.loggedOut;
      const closingSock = sock;
      sock = null;

      if (wasLoggedOut) {
        const authDir = getAuthDir();
        // End the socket before deleting auth state so Baileys stops writing files
        try { closingSock?.end(undefined); } catch {}
        if (existsSync(authDir)) {
          console.log('[whatsappManager] logged out, clearing stale auth state');
          rmSync(authDir, { recursive: true, force: true });
        }
      }

      broadcastStatusChange();

      if (!wasLoggedOut && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(3000 * reconnectAttempts, 15000);
        console.log(`[whatsappManager] will auto-reconnect in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(() => connectWhatsApp(), delay);
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('[whatsappManager] max reconnect attempts reached, giving up');
      }
    }
  });
}

async function disconnectWhatsApp(): Promise<void> {
  console.log('[whatsappManager] disconnectWhatsApp called');
  const currentSock = sock;
  sock = null;

  if (currentSock) {
    try {
      // logout() sends remove-companion-device IQ to WhatsApp servers
      // then calls end() internally — no need to call end() separately
      await currentSock.logout();
    } catch (err) {
      console.log('[whatsappManager] logout completed (thrown Boom is expected):', (err as Error)?.message);
    }
  }

  const authDir = getAuthDir();
  if (existsSync(authDir)) {
    rmSync(authDir, { recursive: true, force: true });
  }

  connectionStatus = 'disconnected';
  currentQrCode = null;
  connectedPhoneNumber = null;
  broadcastStatusChange();
}

function getWhatsAppStatus(): { status: string; phoneNumber?: string } {
  return { status: connectionStatus, ...(connectedPhoneNumber ? { phoneNumber: connectedPhoneNumber } : {}) };
}

async function sendWhatsAppDocument(
  phoneNumber: string,
  pdfBuffer: Buffer,
  fileName: string,
  caption?: string,
): Promise<{ success: boolean; error?: string }> {
  console.log('[whatsappManager] sendWhatsAppDocument called, phone:', phoneNumber, 'bufferSize:', pdfBuffer.length, 'fileName:', fileName);
  if (!sock || connectionStatus !== 'connected') {
    console.log('[whatsappManager] not connected, cannot send');
    return { success: false, error: 'WhatsApp is not connected' };
  }

  try {
    const jid = phoneToJid(phoneNumber);
    console.log('[whatsappManager] sending to JID:', jid);
    await sock.sendMessage(jid, {
      document: pdfBuffer,
      mimetype: 'application/pdf',
      fileName,
      ...(caption ? { caption } : {}),
    });
    console.log('[whatsappManager] document sent successfully');
    showNotification({
      title: 'Prescription Sent',
      body: 'The document was delivered via WhatsApp successfully.',
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[whatsappManager] send failed:', error);
    captureError(error, { domain: 'infra', component: 'whatsapp', extra: { action: 'send_document', fileName } });
    return { success: false, error: message };
  }
}

export function registerWhatsappIpcHandlers(): void {
  console.log('[whatsappManager] registering IPC handlers');

  ipcMain.handle('whatsapp:connect', async () => {
    console.log('[whatsappManager] IPC whatsapp:connect received');
    reconnectAttempts = 0;
    await connectWhatsApp();
  });

  ipcMain.handle('whatsapp:disconnect', async () => {
    console.log('[whatsappManager] IPC whatsapp:disconnect received');
    await disconnectWhatsApp();
  });

  ipcMain.handle('whatsapp:status', () => {
    return getWhatsAppStatus();
  });

  ipcMain.handle(
    'whatsapp:send-document',
    async (_event, payload: { phoneNumber: string; pdfBuffer: ArrayBuffer; fileName: string; caption?: string }) => {
      console.log('[whatsappManager] IPC whatsapp:send-document received');
      const buffer = Buffer.from(payload.pdfBuffer);
      return sendWhatsAppDocument(payload.phoneNumber, buffer, payload.fileName, payload.caption);
    },
  );

}

export function initWhatsAppAutoConnect(): void {
  const credsPath = path.join(getAuthDir(), 'creds.json');
  console.log('[whatsappManager] checking auto-connect, credsPath:', credsPath, 'exists:', existsSync(credsPath));
  if (existsSync(credsPath)) {
    console.log('[whatsappManager] found existing auth state, auto-connecting');
    connectWhatsApp().catch((error) => {
      captureError(error, { domain: 'infra', component: 'whatsapp', extra: { action: 'auto_connect' } });
      console.error('[whatsappManager] auto-connect failed', error);
    });
  }
}

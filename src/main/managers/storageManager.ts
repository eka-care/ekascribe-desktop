import { app, ipcMain, safeStorage } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ElectronStore from 'electron-store';

const store = new ElectronStore();
const ENCRYPTION_KEY_STORE_KEY = 'storageManager:encryptionKey';
const UNENCRYPTED_PREFIX = 'plain:';
const USE_SAFE_STORAGE = process.platform !== 'darwin';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function storeEncryptionKey(key: Buffer): void {
  const hex = key.toString('hex');
  if (USE_SAFE_STORAGE && safeStorage.isEncryptionAvailable()) {
    store.set(ENCRYPTION_KEY_STORE_KEY, safeStorage.encryptString(hex).toString('hex'));
  } else {
    store.set(ENCRYPTION_KEY_STORE_KEY, UNENCRYPTED_PREFIX + hex);
  }
}

function loadEncryptionKey(): Buffer | null {
  const raw = store.get(ENCRYPTION_KEY_STORE_KEY) as string | undefined;
  if (!raw) return null;
  if (raw.startsWith(UNENCRYPTED_PREFIX)) {
    return Buffer.from(raw.slice(UNENCRYPTED_PREFIX.length), 'hex');
  }
  if (!USE_SAFE_STORAGE) {
    return null;
  }
  try {
    const hex = safeStorage.decryptString(Buffer.from(raw, 'hex'));
    return Buffer.from(hex, 'hex');
  } catch (e) {
    console.error('[storageManager] Failed to decrypt encryption key', e);
    return null;
  }
}

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const loaded = loadEncryptionKey();
  if (loaded) {
    cachedKey = loaded;
    return cachedKey;
  }
  const newKey = randomBytes(32);
  storeEncryptionKey(newKey);
  cachedKey = newKey;
  return cachedKey;
}

function encryptBuffer(data: Buffer): Buffer {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: [iv (12 bytes)][authTag (16 bytes)][encrypted data]
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptBuffer(data: Buffer): Buffer {
  const key = getEncryptionKey();
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function getStorageBasePath(): string {
  return path.join(app.getPath('userData'), 'file-storage');
}

function resolveSafeFolderPath(folderName: string): string {
  const base = getStorageBasePath();
  const resolved = path.resolve(base, folderName);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`[storageManager] Invalid folder name: ${folderName}`);
  }
  return resolved;
}

async function handleSaveAudio(
  _event: Electron.IpcMainInvokeEvent,
  folderName: string,
  fileName: string,
  fileBuffer: ArrayBuffer,
): Promise<void> {
  const folderPath = resolveSafeFolderPath(folderName);
  const safeName = path.basename(fileName);
  await fs.mkdir(folderPath, { recursive: true });
  const encrypted = encryptBuffer(Buffer.from(fileBuffer));
  await fs.writeFile(path.join(folderPath, safeName), encrypted);
}

async function handleFetchAudio(
  _event: Electron.IpcMainInvokeEvent,
  folderName: string,
  fileName: string,
): Promise<ArrayBuffer | null> {
  const folderPath = resolveSafeFolderPath(folderName);
  const safeName = path.basename(fileName);

  if (!safeName) {
    // Empty fileName: read all files and concatenate (matches web behavior)
    let files: string[];
    try {
      files = await fs.readdir(folderPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (files.length === 0) return null;
    files.sort();
    const buffers = await Promise.all(
      files.map(async (f) => decryptBuffer(await fs.readFile(path.join(folderPath, f))))
    );
    const combined = Buffer.concat(buffers);
    return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength) as ArrayBuffer;
  }

  const encrypted = await fs.readFile(path.join(folderPath, safeName));
  const decrypted = decryptBuffer(encrypted);
  return decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer;
}

async function handleListFiles(
  _event: Electron.IpcMainInvokeEvent,
  folderName: string,
): Promise<string[]> {
  const folderPath = resolveSafeFolderPath(folderName);
  try {
    return await fs.readdir(folderPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function clearStorage(): Promise<void> {
  const base = getStorageBasePath();
  try {
    await fs.rm(base, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function handleDeleteAll(_event: Electron.IpcMainInvokeEvent): Promise<void> {
  return clearStorage();
}

export function registerStorageIpcHandlers(): void {
  ipcMain.handle('storage:saveAudio', handleSaveAudio);
  ipcMain.handle('storage:fetchAudio', handleFetchAudio);
  ipcMain.handle('storage:listFiles', handleListFiles);
  ipcMain.handle('storage:deleteAll', handleDeleteAll);
}

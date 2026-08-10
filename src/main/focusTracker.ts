import { BrowserWindow } from 'electron';
import { NativeBridge } from './nativeCommunication/NativeBridge';

let debounceTimer: NodeJS.Timeout | null = null;
let currentFocusState: boolean = false;
let attachedWindow: BrowserWindow | null = null;
let attachedBridge: NativeBridge | null = null;

const DEBOUNCE_MS = 50;

function onFocus(): void {
  scheduleFocusChange(true);
}

function onBlur(): void {
  scheduleFocusChange(false);
}

function onMinimize(): void {
  // minimize does not reliably fire blur; treat it as a focus loss
  scheduleFocusChange(false);
}

function onRestore(): void {
  // restore brings the window back but focus may arrive separately via 'focus'
  // only mark focused if the window actually has OS focus after restore
  if (attachedWindow && !attachedWindow.isDestroyed() && attachedWindow.isFocused()) {
    scheduleFocusChange(true);
  }
}

function scheduleFocusChange(isFocused: boolean): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (isFocused === currentFocusState) return; // suppress duplicate
    currentFocusState = isFocused;
    sendFocusEvent(isFocused);
  }, DEBOUNCE_MS);
}

function sendFocusEvent(isFocused: boolean): void {
  if (!attachedBridge?.isConnected()) {
    console.log('[FocusTracker] bridge not connected, skipping focus event');
    return;
  }
  attachedBridge.sendEvent('app.focus.changed', { isFocused });
}

function attach(mainWindow: BrowserWindow, bridge: NativeBridge): void {
  detach(); // idempotent re-attach

  attachedWindow = mainWindow;
  attachedBridge = bridge;

  mainWindow.on('focus', onFocus);
  mainWindow.on('blur', onBlur);
  mainWindow.on('minimize', onMinimize);
  mainWindow.on('restore', onRestore);
}

function detach(): void {
  if (attachedWindow && !attachedWindow.isDestroyed()) {
    attachedWindow.removeListener('focus', onFocus);
    attachedWindow.removeListener('blur', onBlur);
    attachedWindow.removeListener('minimize', onMinimize);
    attachedWindow.removeListener('restore', onRestore);
  }
  attachedWindow = null;
  attachedBridge = null;
  currentFocusState = false;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

export { attach, detach };

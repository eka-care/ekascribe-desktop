// Minimal preload for the app-authored popup windows (update prompt, notification
// permission prompt). They previously ran with nodeIntegration and no context isolation
// just to reach `ipcRenderer.send`; this exposes exactly the two channels they need and
// nothing else, so the popups can run fully sandboxed like every other window.
import { contextBridge, ipcRenderer } from 'electron';

type UpdaterPopupAction = 'later' | 'update';
type NotificationPromptAction = 'allow' | 'deny' | 'neverAsk';

const UPDATER_ACTIONS: ReadonlySet<string> = new Set(['later', 'update']);
const NOTIFICATION_ACTIONS: ReadonlySet<string> = new Set(['allow', 'deny', 'neverAsk']);

contextBridge.exposeInMainWorld('popupApi', {
  sendUpdaterAction: (action: UpdaterPopupAction) => {
    if (!UPDATER_ACTIONS.has(action)) return;
    ipcRenderer.send('updater:popup-action', action);
  },
  sendNotificationPromptAction: (action: NotificationPromptAction) => {
    if (!NOTIFICATION_ACTIONS.has(action)) return;
    ipcRenderer.send('notification-prompt:action', action);
  },
});

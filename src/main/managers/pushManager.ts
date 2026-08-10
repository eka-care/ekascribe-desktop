import { app, net, pushNotifications } from 'electron';
import ElectronStore from 'electron-store';
import { PushReceiver } from '@eneris/push-receiver';
import type { Types } from '@eneris/push-receiver';
import { getAuthToken } from './authManager';
import { showNotification } from './notificationManager';
import { captureError } from './sentryManager';

const store = new ElectronStore();
const APNS_TOKEN_KEY = 'push.apnsToken';
const FCM_CREDENTIALS_KEY = 'push.fcmCredentials';
const FCM_PERSISTENT_IDS_KEY = 'push.fcmPersistentIds';

const DEVICE_REGISTER_URL = 'https://api.eka.care/v1/devices/register';

let fcmReceiver: PushReceiver | null = null;

function getFirebaseConfig(): Types.FirebaseConfig {
  return {
    projectId: process.env.PUSH_FIREBASE_PROJECT_ID ?? '',
    appId: process.env.PUSH_FIREBASE_APP_ID ?? '',
    apiKey: process.env.PUSH_FIREBASE_API_KEY ?? '',
    messagingSenderId: process.env.PUSH_FIREBASE_SENDER_ID ?? '',
  };
}

async function registerDeviceWithBackend(token: string, platform: 'apns' | 'fcm'): Promise<void> {
  const authToken = getAuthToken();
  if (!authToken) {
    console.log('[pushManager] no auth token, skipping device registration');
    return;
  }

  try {
    const response = await (net.fetch as Function)(DEVICE_REGISTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        token,
        platform,
        appVersion: app.getVersion(),
      }),
      bypassCustomProtocolHandlers: true,
    });
    if (response.ok) {
      console.log(`[pushManager] device registered with backend (${platform})`);
    } else {
      const body = await response.text().catch(() => '');
      console.error(`[pushManager] device registration failed: ${response.status} ${body}`);
    }
  } catch (error) {
    captureError(error, { domain: 'infra', component: 'push', extra: { platform, action: 'device_register' } });
    console.error('[pushManager] device registration error:', error);
  }
}

async function initMacPush(): Promise<void> {
  try {
    const token = await pushNotifications.registerForAPNSNotifications();
    console.log('[pushManager] APNS token received');

    const stored = store.get(APNS_TOKEN_KEY) as string | undefined;
    if (stored !== token) {
      store.set(APNS_TOKEN_KEY, token);
      await registerDeviceWithBackend(token, 'apns');
    }

    pushNotifications.on('received-apns-notification', (_event, userInfo) => {
      const info = userInfo as Record<string, any>;
      const alert = info?.aps?.alert;
      const title: string = (typeof alert === 'object' ? alert?.title : null) ?? info?.title ?? 'EkaScribe';
      const body: string = (typeof alert === 'object' ? alert?.body : typeof alert === 'string' ? alert : null) ?? info?.body ?? '';
      if (body) {
        showNotification({ title, body });
      }
    });
  } catch (error) {
    captureError(error, { domain: 'infra', component: 'push', extra: { platform: 'darwin', action: 'apns_register' } });
    console.error('[pushManager] APNS registration failed:', error);
  }
}

async function initWindowsPush(): Promise<void> {
  const config = getFirebaseConfig();
  if (!config.projectId || !config.apiKey || !config.appId || !config.messagingSenderId) {
    console.log('[pushManager] Firebase credentials not configured, skipping Windows push setup');
    return;
  }

  try {
    const storedCredentials = store.get(FCM_CREDENTIALS_KEY) as Types.Credentials | undefined;
    const persistentIds = (store.get(FCM_PERSISTENT_IDS_KEY) as string[] | undefined) ?? [];

    fcmReceiver = new PushReceiver({
      firebase: config,
      credentials: storedCredentials,
      persistentIds,
      bundleId: 'care.eka.ekascribe',
    });

    fcmReceiver.onCredentialsChanged(({ newCredentials }) => {
      console.log('[pushManager] FCM credentials changed, persisting and registering with backend');
      store.set(FCM_CREDENTIALS_KEY, newCredentials);
      const fcmToken = newCredentials.fcm?.token;
      if (fcmToken) {
        void registerDeviceWithBackend(fcmToken, 'fcm');
      }
    });

    fcmReceiver.onNotification(({ message, persistentId }) => {
      // Deduplicate messages already seen across sessions
      const ids = (store.get(FCM_PERSISTENT_IDS_KEY) as string[] | undefined) ?? [];
      if (!ids.includes(persistentId)) {
        store.set(FCM_PERSISTENT_IDS_KEY, [...ids.slice(-200), persistentId]);
      }

      const title = String(message.notification?.title ?? message.data?.['title'] ?? 'EkaScribe');
      const body = String(message.notification?.body ?? message.data?.['body'] ?? '');
      if (body) {
        showNotification({ title, body });
      }
    });

    await fcmReceiver.connect();
    const fcmToken = fcmReceiver.fcmToken;
    console.log('[pushManager] FCM receiver connected, token:', fcmToken?.slice(0, 8) + '...');

    // Register if this is a fresh connection (no prior credentials)
    if (fcmToken && !storedCredentials) {
      await registerDeviceWithBackend(fcmToken, 'fcm');
    }
  } catch (error) {
    captureError(error, { domain: 'infra', component: 'push', extra: { platform: 'win32', action: 'fcm_init' } });
    console.error('[pushManager] FCM initialization failed:', error);
  }
}

export async function initPushManager(): Promise<void> {
  if (process.platform === 'darwin') {
    await initMacPush();
  } else if (process.platform === 'win32') {
    await initWindowsPush();
  }
}

export function disposePushManager(): void {
  fcmReceiver?.destroy();
  fcmReceiver = null;
  if (process.platform === 'darwin') {
    try {
      pushNotifications.unregisterForAPNSNotifications();
    } catch {
      // best-effort
    }
  }
}

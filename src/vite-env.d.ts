/// <reference types="vite/client" />

interface AuthApi {
  onAuthSuccess: (refreshToken: string, authToken: string) => void;
  getRefreshToken: () => Promise<string | null>;
  getAuthToken: () => Promise<string | null>;
  getTokens: () => Promise<{ authToken: string | null; refreshToken: string | null }>;
  startLogin: () => Promise<{
    accessToken: string;
    refreshToken: string;
  }>;
  logout: () => Promise<void>;
}

type StartRecordingResult = { granted: true } | { granted: false; error: string; errorType: string };

interface RecordingApi {
  startRecording: () => Promise<StartRecordingResult>;
}

type ScribeRecordingStatus =
  | 'READY'
  | 'INITIALIZING'
  | 'RECORDING'
  | 'RECORDING_PAUSED'
  | 'RECORDING_STOPPED'
  | 'ANALYZING'
  | 'ANALYZING_FAILED'
  | 'OUTPUT_GENERATED';

interface ScribeApi {
  onStartRequest: (callback: () => void) => () => void;
  onStopRequest: (callback: () => void) => () => void;
  onPauseRequest: (callback: () => void) => () => void;
  onResumeRequest: (callback: () => void) => () => void;
  onSetupScribeApp: (callback: (payload: { accessToken: string | null; refreshToken?: string | null }) => void) => () => void;
  updateStatus: (status: ScribeRecordingStatus, sessionId: string | null) => void;
}

interface EkascribeWebApi {
  start: () => Promise<string>;
  stop: () => Promise<void>;
  getUrl: () => Promise<string>;
}

interface NetworkRequestPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  retry: boolean;
  ekaHost: string;
}

interface NetworkResponsePayload {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

interface NetworkApi {
  request: (payload: NetworkRequestPayload) => Promise<NetworkResponsePayload>;
}

interface DeepLinkApi {
  onDeepLink: (callback: (url: string) => void) => () => void;
}

interface DotnetRuntimeStatus {
  isAvailable: boolean;
  installUrl: string;
  requiredMajorVersion: number;
  checkedAtIso: string;
  detectedRuntimeVersion: string | null;
  message: string | null;
}

interface ClipboardApi {
  write: (payload: { html?: string; text: string }) => Promise<void>;
}

interface SystemApi {
  getDotnetRuntimeStatus: (options?: { refresh?: boolean }) => Promise<DotnetRuntimeStatus>;
  openExternal: (url: string) => Promise<void>;
}

interface OverlayNotificationPreferences {
  joinVideoConferencingAndStartTranscribing: boolean;
  meetingIsBeingRecorded: boolean;
  meetingIsSummarized: boolean;
}

interface OverlayShortcutPreferences {
  enabled: boolean;
  shortcut: string;
}

interface WhatsAppAutoSendPreferences {
  send_via_linked_device: boolean;
  auto_send_rate_limit: number;
  allow_partner_emr_auto_send: boolean;
}

interface DesktopSettingsApi {
  openSettings: () => void;
  getNotificationPreferences: () => Promise<OverlayNotificationPreferences>;
  updateNotificationPreferences: (
    prefs: Partial<OverlayNotificationPreferences>
  ) => Promise<OverlayNotificationPreferences>;
  getShortcutPreferences: () => Promise<OverlayShortcutPreferences>;
  updateShortcutPreferences: (
    prefs: Partial<OverlayShortcutPreferences>
  ) => Promise<OverlayShortcutPreferences>;
  getWhatsAppAutoSendPrefs: () => Promise<WhatsAppAutoSendPreferences>;
  updateWhatsAppAutoSendPrefs: (
    prefs: Partial<WhatsAppAutoSendPreferences>
  ) => Promise<WhatsAppAutoSendPreferences>;
  onWhatsAppPrefsUpdated: (callback: (prefs: WhatsAppAutoSendPreferences) => void) => () => void;
}

interface NotificationApi {
  show(opts: { title: string; body: string; silent?: boolean }): Promise<void>;
  onClick(callback: (data: Record<string, unknown> | null) => void): () => void;
}

interface LoginPipApi {
  onEnter: (callback: () => void) => () => void;
  onExit: (callback: (route: string) => void) => () => void;
  onState: (callback: (state: LoginPipStatePayload) => void) => () => void;
  cancelLogin: () => void;
  shrinkToPip: () => void;
  getState: () => Promise<LoginPipStatePayload | null>;
}

declare global {
  /** Wire format of `login-pip:state`; mirrors `PipState` in loginWindowManager. */
  type LoginPipStatePayload =
    | { type: 'waiting' }
    | { type: 'code'; userCode: string; verificationUrl: string; expiresAt: number }
    | { type: 'error'; message: string };

  interface Window {
    authApi: AuthApi;
    recordingApi: RecordingApi;
    scribeApi: ScribeApi;
    ekascribeWebApi: EkascribeWebApi;
    networkApi: NetworkApi;
    deepLinkApi: DeepLinkApi;
    clipboardApi: ClipboardApi;
    systemApi: SystemApi;
    notificationApi: NotificationApi;
    desktopSettingsApi: DesktopSettingsApi;
    loginPipApi: LoginPipApi;
  }
}

export {};

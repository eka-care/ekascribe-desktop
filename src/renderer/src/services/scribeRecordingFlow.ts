export type ScribeEnv = 'PROD' | 'DEV';

/** Central recording status; pill and renderer UI observe this (via IPC + state file). */
export enum ScribeRecordingStatus {
  READY = 'READY',
  INITIALIZING = 'INITIALIZING',
  RECORDING = 'RECORDING',
  RECORDING_PAUSED = 'RECORDING_PAUSED',
  RECORDING_STOPPED = 'RECORDING_STOPPED',
  ANALYZING = 'ANALYZING',
  ANALYZING_FAILED = 'ANALYZING_FAILED',
  OUTPUT_GENERATED = 'OUTPUT_GENERATED',
}

export type FetchOutputResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string; errorCode?: string };

export type SetupAndStartOptions = {
  /** Override auth token; if not set, uses window.authApi.getAuthToken() */
  accessToken?: string;
  env?: ScribeEnv;
  /** Kept for compatibility; no-op in base app mode. */
  initOverrides?: Record<string, unknown>;
  /** Kept for compatibility; no-op in base app mode. */
  sharedWorkerUrl?: string;
};

export type SetupAndStartResult =
  | { success: true; txn_id: string; message: string }
  | { success: false; error: string; errorCode?: string };

export type StopRecordingResult =
  | { success: true; message: string }
  | { success: false; error: string; errorCode?: string };

let isRecordingActive = false;

// Central state for recording status (pill + renderer observe this)
let currentStatus: ScribeRecordingStatus = ScribeRecordingStatus.READY;
let currentSessionId: string | null = null;
type StatusListener = (status: ScribeRecordingStatus, sessionId: string | null) => void;
const statusListeners = new Set<StatusListener>();

function setStatus(status: ScribeRecordingStatus, sessionId: string | null = null): void {
  currentStatus = status;
  currentSessionId = sessionId;
  statusListeners.forEach((cb) => cb(currentStatus, currentSessionId));
  if (typeof window !== 'undefined' && window.scribeApi?.updateStatus) {
    window.scribeApi.updateStatus(currentStatus, currentSessionId);
  }
}

export function getScribeStatus(): { status: ScribeRecordingStatus; sessionId: string | null } {
  return { status: currentStatus, sessionId: currentSessionId };
}

export function subscribeToScribeStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  listener(currentStatus, currentSessionId);
  return () => statusListeners.delete(listener);
}

const BASE_APP_ERROR_CODE = {
  MIC: 'MICROPHONE',
  TXN_INIT_FAILED: 'TXN_INIT_FAILED',
  TXN_STOP_FAILED: 'TXN_STOP_FAILED',
  OUTPUT_UNAVAILABLE: 'OUTPUT_UNAVAILABLE',
} as const;

/**
 * Ensures microphone permission is granted (OS + renderer).
 * Call this before Scribe setup so SDK startRecording() doesn't fail.
 */
export async function ensureMicPermission(): Promise<{ granted: boolean; error?: string }> {
  try {
    const result = await window.recordingApi.startRecording();
    if (!result.granted) return { granted: false, error: result.error };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return { granted: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Microphone access denied';
    const denied =
      err instanceof DOMException && err.name === 'NotAllowedError';
    return {
      granted: false,
      error: denied ? 'Microphone access denied' : message,
    };
  }
}

/**
 * Single reusable flow: setup Scribe (instance + initTransaction) and start recording.
 * Use from HomePage button, floating button, or global shortcut handler.
 */
export async function setupAndStartScribeRecording(
  options: SetupAndStartOptions = {}
): Promise<SetupAndStartResult> {
  const accessToken = options.accessToken ?? (await window.authApi.getAuthToken());
  if (!accessToken) {
    return { success: false, error: 'Not authenticated', errorCode: 'auth' };
  }

  setStatus(ScribeRecordingStatus.INITIALIZING, null);

  const mic = await ensureMicPermission();
  if (!mic.granted) {
    setStatus(ScribeRecordingStatus.READY, null);
    return {
      success: false,
      error: mic.error ?? 'Microphone access denied',
      errorCode: BASE_APP_ERROR_CODE.MIC,
    };
  }

  const effectiveTxnId = crypto.randomUUID();
  isRecordingActive = true;
  setStatus(ScribeRecordingStatus.RECORDING, effectiveTxnId);

  return {
    success: true,
    txn_id: effectiveTxnId,
    message: 'Recording started',
  };
}

export function isScribeRecording(): boolean {
  return isRecordingActive;
}

export function pauseScribeRecording(): void {
  if (currentStatus === ScribeRecordingStatus.RECORDING) {
    setStatus(ScribeRecordingStatus.RECORDING_PAUSED, currentSessionId);
  }
}

export function resumeScribeRecording(): void {
  if (currentStatus === ScribeRecordingStatus.RECORDING_PAUSED) {
    setStatus(ScribeRecordingStatus.RECORDING, currentSessionId);
  }
}

export async function stopScribeRecording(): Promise<StopRecordingResult> {
  if (!isRecordingActive) {
    return { success: false, error: 'Recording is not active', errorCode: BASE_APP_ERROR_CODE.TXN_STOP_FAILED };
  }

  setStatus(ScribeRecordingStatus.RECORDING_STOPPED, currentSessionId);

  setStatus(ScribeRecordingStatus.ANALYZING, currentSessionId);
  isRecordingActive = false;

  setStatus(ScribeRecordingStatus.OUTPUT_GENERATED, currentSessionId);
  return {
    success: true,
    message: 'Recording stopped',
  };
}

/**
 * Fetch output for a session by its transaction/session ID.
 * Uses existing scribe instance if available (same auth), otherwise creates one with accessToken.
 */
export async function fetchOutputBySessionId(
  sessionId: string,
  options: { accessToken?: string; env?: ScribeEnv } = {}
): Promise<FetchOutputResult> {
  const accessToken = options.accessToken ?? (typeof window !== 'undefined' ? await window.authApi.getAuthToken() : undefined);
  if (!accessToken) {
    return { success: false, error: 'Not authenticated', errorCode: 'auth' };
  }

  console.warn('Output fetch is unavailable in base app mode without ekascribe SDK', { sessionId, hasToken: Boolean(accessToken) });
  return {
    success: false,
    error: 'Output fetch is unavailable in base app mode',
    errorCode: BASE_APP_ERROR_CODE.OUTPUT_UNAVAILABLE,
  };
}

/**
 * Convenience: fetch output for the most recent Scribe session.
 * Uses SDK pollSessionOutput with only txn_id (no template_id or max_polling_time).
 */
export async function fetchOutputForLastSession(
  options: { accessToken?: string; env?: ScribeEnv } = {}
): Promise<FetchOutputResult> {
  const lastSessionId = currentSessionId;
  if (!lastSessionId) {
    return { success: false, error: 'No Scribe session found' };
  }
  return fetchOutputBySessionId(lastSessionId, options);
}

/**
 * Fetch transcript output for a session by transaction/session ID.
 */
export async function fetchTranscriptBySessionId(
  sessionId: string,
  options: { accessToken?: string; env?: ScribeEnv } = {}
): Promise<FetchOutputResult> {
  const accessToken = options.accessToken ?? (typeof window !== 'undefined' ? await window.authApi.getAuthToken() : undefined);
  if (!accessToken) {
    return { success: false, error: 'Not authenticated', errorCode: 'auth' };
  }

  console.warn('Transcript fetch is unavailable in base app mode without ekascribe SDK', { sessionId, hasToken: Boolean(accessToken) });
  return {
    success: false,
    error: 'Transcript fetch is unavailable in base app mode',
    errorCode: BASE_APP_ERROR_CODE.OUTPUT_UNAVAILABLE,
  };
}

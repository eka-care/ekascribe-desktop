import fs from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';
import { getApiUpstreamBase } from '../config';
import { injectElectronEnv } from './ekascribeWebManager';

// Device-code login (RFC 8628): the backend issues a short user_code for the
// human and a private device_code we poll with until it returns tokens.
// ─── BACKEND CONTRACT: everything the server dictates lives in this block ───
const INITIATE_PATH = '/connect-auth/v1/device/code';
const POLL_PATH = '/connect-auth/v1/device/token';

/** Overridden by `interval` / `expires_in` in the initiate response when present. */
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_CODE_LIFETIME_MS = 10 * 60 * 1000;

// Sent with HTTP 400, so error.code — not the status — says waiting vs failed.
const PENDING_MARKERS = ['authorization_pending', 'pending', 'waiting'];
/** Server asking us to back off; polling continues at a longer interval. */
const SLOW_DOWN_MARKER = 'slow_down';
// Stop polling. unsupported_auth_mode = deployment isn't running AUTH_MODE=jwt.
const TERMINAL_MARKERS = [
  'expired_token',
  'expired',
  'access_denied',
  'denied',
  'cancelled',
  'canceled',
  'unsupported_auth_mode',
];
// ─── END BACKEND CONTRACT ───────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15000;

// Give up after this many polls we can't interpret, so a persistently broken
// endpoint reports itself instead of masquerading as "code expired" 10min later.
const MAX_UNRECOGNISED_POLLS = 5;

export type DeviceLoginTokens = {
  accessToken: string;
  refreshToken: string;
};

/** What the UI renders while polling runs in the background. */
export type DeviceCode = {
  userCode: string;
  verificationUrl: string;
  /** Epoch ms, for the countdown. */
  expiresAt: number;
};

type InitiateResult = DeviceCode & { longCode: string; pollIntervalMs: number };

type PollOutcome =
  | { state: 'pending' }
  | { state: 'slow_down' }
  | { state: 'ready'; tokens: DeviceLoginTokens }
  | { state: 'terminal'; reason: string }
  | { state: 'unknown'; reason: string };

let activeLogin: { promise: Promise<DeviceLoginTokens>; controller: AbortController } | null = null;

// Writes to authManager's login.log so a login reads as one story.
function logDeviceLogin(message: string, meta?: unknown): void {
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

function upstreamUrl(pathname: string): string {
  return `${getApiUpstreamBase()}${pathname}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

// Returns status alongside the body — a poll signals pending through either.
async function postJson(
  url: string,
  body: Record<string, unknown>,
  operation: string,
  signal: AbortSignal
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = (await (net.fetch as Function)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    // Cancel kills an in-flight request instead of waiting out the timeout.
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    bypassCustomProtocolHandlers: true,
  })) as Response;

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      parsed = asRecord(JSON.parse(raw));
    } catch {
      // Status still carries meaning, so don't fail outright.
      logDeviceLogin(`${operation} returned non-JSON body`, { status: response.status });
    }
  }
  return { status: response.status, body: parsed, raw };
}

/** Maps the initiate response onto what the flow and the UI need. */
function readInitiateResponse(body: Record<string, unknown>): InitiateResult {
  const userCode = readString(body, 'user_code', 'userCode');
  const longCode = readString(body, 'device_code', 'long_code', 'longCode');
  // _complete prefills the code, so the user only has to click.
  const verificationUrl = readString(body, 'verification_uri_complete', 'verification_uri');

  if (!userCode || !longCode || !verificationUrl) {
    throw new Error(
      '[device-login] initiate response missing user_code, device_code or verification_uri'
    );
  }

  const expiresInSec = readNumber(body, 'expires_in', 'expiresIn');
  const intervalSec = readNumber(body, 'interval', 'poll_interval');

  return {
    userCode,
    longCode,
    verificationUrl,
    expiresAt: Date.now() + (expiresInSec !== null ? expiresInSec * 1000 : DEFAULT_CODE_LIFETIME_MS),
    pollIntervalMs: intervalSec !== null ? intervalSec * 1000 : DEFAULT_POLL_INTERVAL_MS,
  };
}

// Anything uninterpretable is 'unknown', not 'pending': the caller retries it a
// few times so a transient 5xx is survivable, then gives up with the real reason.
function readPollResponse(status: number, body: Record<string, unknown>): PollOutcome {
  const accessToken = readString(body, 'access_token', 'accessToken');
  const refreshToken = readString(body, 'refresh_token', 'refreshToken');

  if (accessToken && refreshToken) {
    return { state: 'ready', tokens: { accessToken, refreshToken } };
  }

  // The real signal is nested at error.code; flat fields are fallbacks.
  const marker = (
    readString(asRecord(body.error), 'code', 'message') ??
    readString(body, 'error', 'status', 'detail', 'message') ??
    ''
  ).toLowerCase();

  if (marker.includes(SLOW_DOWN_MARKER)) {
    return { state: 'slow_down' };
  }
  if (TERMINAL_MARKERS.some((term) => marker.includes(term))) {
    return { state: 'terminal', reason: marker };
  }
  if (status === 202 || PENDING_MARKERS.some((term) => marker.includes(term))) {
    return { state: 'pending' };
  }
  if (status === 200 && !marker) {
    // Acknowledged, but nothing yet.
    return { state: 'pending' };
  }

  return { state: 'unknown', reason: marker || `HTTP ${status}` };
}

/** Sleep that rejects the moment the login is cancelled. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs a device login; `onCode` fires before polling so the UI paints at once. */
// Single-flight: a concurrent call joins the attempt instead of issuing a rival code.
export function startDeviceLogin(onCode: (code: DeviceCode) => void): Promise<DeviceLoginTokens> {
  if (activeLogin) {
    return activeLogin.promise;
  }

  const controller = new AbortController();
  const { signal } = controller;

  const promise = (async () => {
    // Login precedes ekascribe-web boot, so nothing has read electron.env yet.
    injectElectronEnv();
    logDeviceLogin('device login started', { initiateUrl: upstreamUrl(INITIATE_PATH) });

    const initiate = await postJson(upstreamUrl(INITIATE_PATH), {}, 'device initiate', signal);
    if (initiate.status < 200 || initiate.status >= 300) {
      throw new Error(`[device-login] initiate failed with status ${initiate.status}: ${initiate.raw}`);
    }

    const { userCode, longCode, verificationUrl, expiresAt, pollIntervalMs } = readInitiateResponse(initiate.body);
    logDeviceLogin('device code issued', {
      userCodeLength: userCode.length,
      verificationUrl,
      pollIntervalMs,
      expiresInMs: expiresAt - Date.now(),
    });

    onCode({ userCode, verificationUrl, expiresAt });

    let intervalMs = pollIntervalMs;
    let unrecognisedPolls = 0;
    for (;;) {
      signal.throwIfAborted();
      if (Date.now() >= expiresAt) {
        throw new Error('[device-login] the code expired before sign-in completed');
      }

      let poll;
      try {
        poll = await postJson(upstreamUrl(POLL_PATH), { device_code: longCode }, 'device poll', signal);
      } catch (pollError) {
        // A cancelled login must stop; a dropped connection or a timed-out
        // request must not, or one blip would discard a code that is still good.
        if (signal.aborted) throw pollError;
        logDeviceLogin('poll request failed; retrying', { error: String(pollError) });
        await abortableDelay(intervalMs, signal);
        continue;
      }

      const outcome = readPollResponse(poll.status, poll.body);

      if (outcome.state === 'ready') {
        logDeviceLogin('device login tokens received');
        return outcome.tokens;
      }
      if (outcome.state === 'terminal') {
        throw new Error(`[device-login] sign-in did not complete: ${outcome.reason}`);
      }
      if (outcome.state === 'unknown') {
        unrecognisedPolls += 1;
        logDeviceLogin('poll returned an unrecognised response', {
          reason: outcome.reason,
          count: unrecognisedPolls,
        });
        if (unrecognisedPolls >= MAX_UNRECOGNISED_POLLS) {
          throw new Error(`[device-login] poll kept returning an unusable response: ${outcome.reason}`);
        }
      } else {
        unrecognisedPolls = 0;
      }
      if (outcome.state === 'slow_down') {
        // Keep the longer interval rather than tripping the limit again.
        intervalMs += pollIntervalMs;
        logDeviceLogin('poll asked to slow down', { intervalMs });
      }

      await abortableDelay(intervalMs, signal);
    }
  })();

  // Only clear the slot if still ours — cancel releases it synchronously.
  const entry = { promise, controller };
  activeLogin = entry;
  void promise.catch(() => undefined).finally(() => {
    if (activeLogin === entry) activeLogin = null;
  });

  return promise;
}

/** Cancels an in-flight login; no-op if idle. */
// Frees the slot at once so an immediate retry gets a fresh code.
export function cancelDeviceLogin(reason: Error): void {
  const inFlight = activeLogin;
  if (!inFlight) return;
  activeLogin = null;
  inFlight.controller.abort(reason);
}

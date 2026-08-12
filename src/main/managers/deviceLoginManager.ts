import fs from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';
import { getApiUpstreamBase } from '../config';
import { injectElectronEnv } from './ekascribeWebManager';

/**
 * Device-code login: the desktop app asks the backend for a short `user_code`
 * (shown to the user) paired with a `long_code` (kept private). The user opens
 * the verification link in a browser and enters the short code there; meanwhile
 * this process polls with the long code until the backend hands back tokens.
 *
 * Chosen over a redirect-based flow because it needs no loopback callback
 * server and no custom-scheme round trip — the browser never has to find its
 * way back to the app.
 *
 * ─── BACKEND CONTRACT ───────────────────────────────────────────────────────
 * Everything the backend dictates is in this block. When the endpoints are
 * finalised, these are the only lines that change; the flow below is written
 * against the mappers, not against any particular payload shape.
 */
const INITIATE_PATH = '/connect-auth/v1/device/code';
const POLL_PATH = '/connect-auth/v1/device/token';

/**
 * Where the user enters the code, used only if the initiate response omits one
 * (`verification_uri_complete` prefills the code, so it is preferred). Derived
 * from the configured upstream rather than hardcoded, so it follows whichever
 * backend the build points at instead of stranding hosted builds on dev.
 */
const VERIFICATION_PATH = '/auth/activate';

/** Overridden by `interval` / `expires_in` in the initiate response when present. */
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_CODE_LIFETIME_MS = 10 * 60 * 1000;

/**
 * Markers meaning "the user hasn't finished yet" rather than a failure. The
 * backend returns these with HTTP 400, so status alone can't be trusted — the
 * body's `error.code` is what actually distinguishes waiting from failing.
 */
const PENDING_MARKERS = ['authorization_pending', 'pending', 'waiting'];
/** Server asking us to back off; polling continues at a longer interval. */
const SLOW_DOWN_MARKER = 'slow_down';
/**
 * Markers that mean the attempt is over and polling must stop.
 * `unsupported_auth_mode` means the deployment is not running AUTH_MODE=jwt,
 * so device sign-in is unavailable there at all.
 */
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

export type DeviceLoginTokens = {
  accessToken: string;
  refreshToken: string;
};

/** What the UI needs to render while polling runs in the background. */
export type DeviceCode = {
  userCode: string;
  verificationUrl: string;
  /** Epoch ms the code stops being usable, for the countdown. */
  expiresAt: number;
};

type InitiateResult = DeviceCode & { longCode: string; pollIntervalMs: number };

type PollOutcome =
  | { state: 'pending' }
  | { state: 'slow_down' }
  | { state: 'ready'; tokens: DeviceLoginTokens }
  | { state: 'terminal'; reason: string };

let activeLogin: { promise: Promise<DeviceLoginTokens>; controller: AbortController } | null = null;

/** Mirrors `logLogin` in authManager — same file, so a login reads as one story. */
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

/**
 * POSTs JSON and hands back the parsed body plus the status, because this flow
 * reads meaning from both: a poll can signal "still pending" through either.
 */
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
    // Cancelling the login tears down an in-flight request immediately rather
    // than leaving the user waiting out the per-request timeout.
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    bypassCustomProtocolHandlers: true,
  })) as Response;

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      parsed = asRecord(JSON.parse(raw));
    } catch {
      // Non-JSON body: status still carries meaning, so don't fail outright.
      logDeviceLogin(`${operation} returned non-JSON body`, { status: response.status });
    }
  }
  return { status: response.status, body: parsed, raw };
}

/** Maps the initiate response onto what the flow and the UI need. */
function readInitiateResponse(body: Record<string, unknown>): InitiateResult {
  const userCode = readString(body, 'user_code', 'userCode');
  const longCode = readString(body, 'long_code', 'longCode', 'device_code');

  if (!userCode || !longCode) {
    throw new Error('[device-login] initiate response missing user_code or long_code');
  }

  const expiresInSec = readNumber(body, 'expires_in', 'expiresIn');
  const intervalSec = readNumber(body, 'interval', 'poll_interval');

  return {
    userCode,
    longCode,
    // `_complete` carries the code as a query param, so the user only has to click.
    verificationUrl:
      readString(body, 'verification_uri_complete', 'verification_uri', 'verification_url') ??
      upstreamUrl(VERIFICATION_PATH),
    expiresAt: Date.now() + (expiresInSec !== null ? expiresInSec * 1000 : DEFAULT_CODE_LIFETIME_MS),
    pollIntervalMs: intervalSec !== null ? intervalSec * 1000 : DEFAULT_POLL_INTERVAL_MS,
  };
}

/**
 * Classifies one poll. Tokens win outright; otherwise a pending marker (in any
 * of the usual fields, or a bare 202) keeps the loop alive. Anything explicitly
 * terminal stops it. An unrecognised failure is treated as pending on purpose —
 * a transient 5xx mid-login should not throw away a code the user is still
 * typing; the deadline is what ultimately ends the loop.
 */
function readPollResponse(status: number, body: Record<string, unknown>): PollOutcome {
  const accessToken = readString(body, 'access_token', 'accessToken');
  const refreshToken = readString(body, 'refresh_token', 'refreshToken');

  if (accessToken && refreshToken) {
    return { state: 'ready', tokens: { accessToken, refreshToken } };
  }

  // The backend nests the real signal as `error.code`; the flat fields are
  // fallbacks for other shapes.
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
    // 200 with neither tokens nor a marker — the backend acknowledged but has
    // nothing yet.
    return { state: 'pending' };
  }

  logDeviceLogin('poll returned an unrecognised response; continuing to poll', { status, marker });
  return { state: 'pending' };
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

/**
 * Runs a full device login. `onCode` fires as soon as the backend issues the
 * code — before polling starts — so the UI can paint it immediately.
 *
 * Single-flight: a second call while one is in flight joins the existing
 * attempt rather than issuing a competing code.
 */
export function startDeviceLogin(onCode: (code: DeviceCode) => void): Promise<DeviceLoginTokens> {
  if (activeLogin) {
    return activeLogin.promise;
  }

  const controller = new AbortController();
  const { signal } = controller;

  const promise = (async () => {
    // Login runs before ekascribe-web (and the proxy) boot, so nothing has read
    // electron.env yet — without this an EKA_API_UPSTREAM override would silently
    // not apply to the login path, only to everything after it.
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
    for (;;) {
      signal.throwIfAborted();
      if (Date.now() >= expiresAt) {
        throw new Error('[device-login] the code expired before sign-in completed');
      }

      const poll = await postJson(upstreamUrl(POLL_PATH), { device_code: longCode }, 'device poll', signal);
      const outcome = readPollResponse(poll.status, poll.body);

      if (outcome.state === 'ready') {
        logDeviceLogin('device login tokens received');
        return outcome.tokens;
      }
      if (outcome.state === 'terminal') {
        throw new Error(`[device-login] sign-in did not complete: ${outcome.reason}`);
      }
      if (outcome.state === 'slow_down') {
        // The server enforces a minimum spacing; keep the longer interval for
        // the rest of the attempt rather than tripping it again next poll.
        intervalMs += pollIntervalMs;
        logDeviceLogin('poll asked to slow down', { intervalMs });
      }

      await abortableDelay(intervalMs, signal);
    }
  })();

  // Only clear the slot if it is still ours — cancelDeviceLogin releases it
  // synchronously, so a fresh login may already have claimed it by the time this
  // attempt finishes unwinding.
  const entry = { promise, controller };
  activeLogin = entry;
  void promise.catch(() => undefined).finally(() => {
    if (activeLogin === entry) activeLogin = null;
  });

  return promise;
}

/**
 * Cancels an in-flight login (the PIP panel's Cancel button). No-op if idle.
 *
 * Releases the single-flight slot immediately so a user who cancels and clicks
 * Login again gets a fresh code, rather than joining the attempt being torn down.
 */
export function cancelDeviceLogin(reason: Error): void {
  const inFlight = activeLogin;
  if (!inFlight) return;
  activeLogin = null;
  inFlight.controller.abort(reason);
}

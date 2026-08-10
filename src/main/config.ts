// import { app } from 'electron';

/**
 * DEBUG ONLY — flip to `true` to load ekascribe-web without stored tokens and
 * suppress login/logout redirects. Never active in packaged builds.
 */
// const FORCE_AUTH = true;

// export const FORCE_AUTHENTICATED = !app.isPackaged && FORCE_AUTH;
export const FORCE_AUTHENTICATED = true;

/**
 * Loopback origin of the main-process Express API proxy (see `managers/apiProxyManager.ts`).
 *
 * Every backend call made by the embedded ekascribe-web app targets this origin, so the
 * main process is the app's single network egress: it injects auth, handles 401 refresh,
 * and is the only place that knows the real upstream. Lives here rather than in the proxy
 * manager so `connectAuthRefresh` can reference it without an import cycle.
 */
export const API_PROXY_HOST = 'localhost';
export const API_PROXY_PORT = 6087;
export const API_PROXY_ORIGIN = `http://${API_PROXY_HOST}:${API_PROXY_PORT}`;

const DEFAULT_API_UPSTREAM = 'http://localhost:8000';

/**
 * Real backend the proxy forwards to — the API server on :8000. Override with
 * `EKA_API_UPSTREAM` in `electron.env` (loaded before the proxy starts) to point a build at
 * a deployed environment instead.
 */
export function getApiUpstreamBase(): string {
  const configured = process.env.EKA_API_UPSTREAM?.trim();
  return (configured || DEFAULT_API_UPSTREAM).replace(/\/+$/, '');
}

// import { app } from 'electron';

/**
 * DEBUG ONLY — flip to `true` to load ekascribe-web without stored tokens and
 * suppress login/logout redirects. Never active in packaged builds.
 */
// const FORCE_AUTH = true;

// export const FORCE_AUTHENTICATED = !app.isPackaged && FORCE_AUTH;
export const FORCE_AUTHENTICATED = false;

/**
 * The desktop app's origin, as the API sees it.
 *
 * Renderer calls get this from the browser for free — the window is served from
 * `app://ekascribe`, so Chromium stamps it and validates CORS against it. This constant is
 * for main-process calls only (`connectAuthRefresh`, the `network:request` IPC transport),
 * which have no browser origin of their own and must set the header explicitly.
 *
 * Do NOT use it to rewrite `Origin` on renderer-initiated requests: `webRequest` changes the
 * header on the wire but not the origin CORS is checked against, so rewriting only creates a
 * mismatch the upstream cannot satisfy.
 */
export const ELECTRON_API_ORIGIN = 'app://ekascribe';

/**
 * HTTPS is required, not stylistic: `app://ekascribe` is registered as a secure scheme (the
 * recorder's `getUserMedia` needs a trustworthy context), and a secure page fetching `http://`
 * is active mixed content, which Chromium blocks outright.
 */
const DEFAULT_API_UPSTREAM = 'https://vaarta.bharatai.gov.in';

/**
 * Real backend the proxy forwards to. Override with `EKA_API_UPSTREAM` in `electron.env`
 * (loaded before the proxy starts) to point a build at a different environment.
 */
export function getApiUpstreamBase(): string {
  const configured = process.env.EKA_API_UPSTREAM?.trim();
  return (configured || DEFAULT_API_UPSTREAM).replace(/\/+$/, '');
}

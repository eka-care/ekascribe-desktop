import { app } from 'electron';

const DEFAULT_SENTRY_DSN =
  'https://9fdee524d937127a8be4405c4cc5ca53@o4511732936474624.ingest.de.sentry.io/4511732976844880';

type SentryLike = {
  init: (options: Record<string, unknown>) => void;
  captureMessage: (message: string, context?: Record<string, unknown>) => string;
  captureException: (error: unknown, context?: Record<string, unknown>) => string;
  setUser: (user: { id: string; [key: string]: unknown } | null) => void;
  setTag: (key: string, value: string) => void;
  addBreadcrumb: (breadcrumb: Record<string, unknown>) => void;
};

let initialized = false;
let sentryClient: SentryLike | null | undefined;
let currentSessionId: string | null = null;

function getSentryClient(): SentryLike | null {
  if (sentryClient !== undefined) return sentryClient;
  try {
    sentryClient = require('@sentry/electron/main') as SentryLike;
    return sentryClient;
  } catch {
    sentryClient = null;
    return null;
  }
}

function baseTags(): Record<string, string> {
  const tags: Record<string, string> = { platform: process.platform, arch: process.arch };
  if (currentSessionId) tags.session_id = currentSessionId;
  return tags;
}

function baseExtra(): Record<string, unknown> {
  return {
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
  };
}

export function initMainSentry(): void {
  if (initialized) return;
  const sentry = getSentryClient();
  if (!sentry) {
    initialized = true;
    return;
  }
  sentry.init({
    dsn: DEFAULT_SENTRY_DSN,
    environment: app.isPackaged ? 'production' : 'development',
    release: `EkaScribe@${app.getVersion()}`,
    beforeBreadcrumb(breadcrumb: Record<string, unknown>) {
      const dominated = ['console', 'electron.net', 'http', 'child_process', 'electron', 'navigation'];
      if (breadcrumb.category && dominated.includes(breadcrumb.category as string)) return null;
      return breadcrumb;
    },
  });
  initialized = true;
}

export function setSessionId(sessionId: string): void {
  currentSessionId = sessionId;
  const sentry = getSentryClient();
  if (sentry) sentry.setTag('session_id', sessionId);
}

export function clearSessionId(): void {
  currentSessionId = null;
}

export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  level: 'info' | 'warning' | 'error' = 'info',
): void {
  const sentry = getSentryClient();
  if (!sentry) return;
  sentry.addBreadcrumb({
    category,
    message,
    data: { ...data, ...(currentSessionId ? { session_id: currentSessionId } : {}) },
    level,
  });
}

export function captureLog(name: string, extra?: Record<string, unknown>): void {
  const sentry = getSentryClient();
  if (!sentry) return;
  sentry.captureMessage(name, {
    level: 'info',
    tags: baseTags(),
    extra: { ...baseExtra(), ...extra },
  });
}

const CRITICAL_COMPONENTS = new Set(['native_helper', 'uncaught_exception']);

export function captureError(
  error: unknown,
  context: { domain: string; component?: string; tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  const sentry = getSentryClient();
  if (!sentry) return;
  const isCritical = !!(context.component && CRITICAL_COMPONENTS.has(context.component)) || context.domain === 'crash';
  sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
    level: isCritical ? 'fatal' : undefined,
    tags: {
      ...baseTags(),
      domain: context.domain,
      ...(context.component ? { component: context.component } : {}),
      ...(isCritical ? { critical: 'true' } : {}),
      ...context.tags,
    },
    extra: { ...baseExtra(), ...context.extra },
  });
}

export function identifyUser(userId: string): void {
  const sentry = getSentryClient();
  if (!sentry) return;
  sentry.setUser({ id: userId });
}

export function resetUser(): void {
  const sentry = getSentryClient();
  if (!sentry) return;
  sentry.setUser(null);
}


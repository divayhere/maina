import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

import { log } from './logger';

let installed = false;

export function isSentryConfigured(): boolean {
  return (process.env.EXPO_PUBLIC_SENTRY_DSN ?? '').length > 0;
}

export function initSentry(): void {
  if (installed) return;
  installed = true;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';
  Sentry.init({
    dsn,
    enabled: dsn.length > 0,
    environment: __DEV__ ? 'development' : 'preview',
    release: `maina@${Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '?'}`,
    dist: Constants.nativeBuildVersion ?? undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    enableAutoSessionTracking: true,
    attachStacktrace: true,
  });
  log.addSink((entry) => {
    Sentry.addBreadcrumb({
      timestamp: entry.ts / 1000,
      level: entry.level === 'warn' ? 'warning' : entry.level,
      category: entry.scope,
      message: entry.message,
      data: entry.context,
    });
  });
}

export function captureException(error: unknown, context?: Record<string, unknown>): string | null {
  if (!isSentryConfigured()) return null;
  return Sentry.captureException(error, context ? { extra: context } : undefined);
}

export { Sentry };

import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { initDb } from '@/data/db';
import { listInterruptedSegmentUris, recoverInterruptedMeetings } from '@/data/meetings';
import { ErrorBoundary } from '@/design/ErrorBoundary';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { repairWavFiles, stopRecordingForegroundService } from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { installRemoteLog } from '@/services/remoteLog';
import { installWatchdog } from '@/services/watchdog';

export default function RootLayout() {
  const { theme } = useAppTheme();
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    installWatchdog();
    installRemoteLog();
    log.info('app', 'launch');
    setReady(false);
    setInitError(null);
    initDb()
      .then(async () => {
        const uris = await listInterruptedSegmentUris();
        const repaired = await repairWavFiles(uris);
        const recovered = await recoverInterruptedMeetings();
        await stopRecordingForegroundService().catch(() => {});
        if (recovered > 0) log.warn('recovery', 'interrupted recording recovered', { recovered, repaired });
      })
      .then(() => setReady(true))
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        setInitError(message);
        log.error('init', 'database initialization failed', { err: message });
      });
  }, [attempt]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          {initError ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 28, backgroundColor: theme.bg }}>
              <AppText variant="heading" style={{ textAlign: 'center' }}>Maina needs attention</AppText>
              <AppText variant="body" muted style={{ textAlign: 'center' }}>
                Your meetings were not changed. Database startup failed; retry or share Diagnostics after reopening.
              </AppText>
              <PrimaryButton label="Retry safely" onPress={() => setAttempt((value) => value + 1)} />
            </View>
          ) : ready ? (
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="record" options={{ presentation: 'modal' }} />
              <Stack.Screen name="meeting/[id]" />
              <Stack.Screen name="diagnostics" />
            </Stack>
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg }}>
              <ActivityIndicator color={theme.accent} />
            </View>
          )}
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { initDb } from '@/data/db';
import { useAppTheme } from '@/design/theme';
import { log } from '@/services/logger';

export default function RootLayout() {
  const { theme } = useAppTheme();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initDb()
      .catch((e) => log.error('init', 'db init failed', { err: String(e) }))
      .finally(() => setReady(true));
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {ready ? (
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="record" options={{ presentation: 'modal' }} />
            <Stack.Screen name="meeting/[id]" />
          </Stack>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg }}>
            <ActivityIndicator color={theme.accent} />
          </View>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { log } from '@/services/logger';
import { readPersistedLog } from '@/services/watchdog';

export default function Diagnostics() {
  const { theme } = useAppTheme();
  const [text, setText] = useState('');

  const refresh = useCallback(async () => {
    const live = log.dump();
    const persisted = await readPersistedLog();
    // Prefer the richer of the two.
    setText(live.length >= persisted.length ? live : persisted);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const share = async () => {
    try {
      await Share.share({ message: text || '(no logs yet)' });
    } catch {}
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={styles.topbar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </Pressable>
        <AppText variant="heading">Diagnostics</AppText>
        <Pressable onPress={refresh} hitSlop={12}>
          <Ionicons name="refresh" size={22} color={theme.accent} />
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg }}>
        <AppText variant="mono" muted style={styles.logText}>
          {text || 'No logs captured yet. Reproduce the issue, then come back and tap refresh.'}
        </AppText>
      </ScrollView>

      <View style={{ padding: space.lg }}>
        <PrimaryButton label="Share logs" onPress={share} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.xxxl,
    paddingBottom: space.sm,
  },
  logText: { fontSize: 11, lineHeight: 16 },
});

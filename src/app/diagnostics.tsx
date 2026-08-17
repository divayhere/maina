import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import { AppText, PrimaryButton } from '@/design/components';
import { supportsOnDevice } from '@/core/transcription/nativeSpeech';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import {
  isRecordingForegroundServiceRunning,
  listAudioInputs,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { REMOTE_LOG } from '@/services/remoteConfig';
import { readPersistedLog } from '@/services/watchdog';

export default function Diagnostics() {
  const { theme } = useAppTheme();
  const [text, setText] = useState('');

  const refresh = useCallback(async () => {
    const live = log.dump();
    const persisted = await readPersistedLog();
    const inputs = await listAudioInputs().catch(() => []);
    const snapshot = [
      '=== MAINA HEALTH SNAPSHOT ===',
      `capturedAt=${new Date().toISOString()}`,
      `version=${Constants.expoConfig?.version ?? 'unknown'}`,
      `device=${Device.manufacturer ?? ''} ${Device.modelName ?? ''}`.trim(),
      `os=${Device.osName ?? ''} ${Device.osVersion ?? ''}`.trim(),
      `onDeviceSpeech=${supportsOnDevice()}`,
      `foregroundRecording=${isRecordingForegroundServiceRunning()}`,
      `remoteLogging=${REMOTE_LOG.enabled ? 'enabled' : 'disabled-for-privacy'}`,
      `audioInputs=${inputs.map((input) => `${input.type}:${input.name}`).join(', ') || 'none reported'}`,
      '=== STRUCTURED LOG ===',
    ].join('\n');
    // Prefer the richer of the two.
    setText(`${snapshot}\n${live.length >= persisted.length ? live : persisted}`);
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

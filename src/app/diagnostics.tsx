import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { getOfflineLocales, supportsOnDevice } from '@/core/transcription/nativeSpeech';
import { AppText, Card, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { isRecordingForegroundServiceRunning, listAudioInputs } from '@/hardware/recording/foreground';
import { flushDiagnostics, getDiagnosticsStatus } from '@/services/remoteLog';
import type { DiagnosticsStatus } from '../../modules/maina-recorder/src';

function Row({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  const { theme } = useAppTheme();
  return (
    <View style={styles.row}>
      <AppText variant="body" muted>{label}</AppText>
      <AppText variant="body" color={warning ? theme.warn : undefined} style={styles.value}>{value}</AppText>
    </View>
  );
}

export default function Diagnostics() {
  const { theme } = useAppTheme();
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);
  const [locales, setLocales] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    const [nextStatus, audioInputs, languageState] = await Promise.all([
      getDiagnosticsStatus().catch(() => null),
      listAudioInputs().catch(() => []),
      getOfflineLocales().catch(() => ({ installed: [], supported: [] })),
    ]);
    setStatus(nextStatus);
    setInputs(audioInputs.map((input) => `${input.type}: ${input.name}`));
    setLocales(languageState.installed);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const forceSync = async () => {
    setSyncing(true);
    try {
      await flushDiagnostics();
      setTimeout(() => void refresh(), 1500);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={styles.topbar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </Pressable>
        <AppText variant="heading">System status</AppText>
        <Pressable onPress={() => void refresh()} hitSlop={12}>
          <Ionicons name="refresh" size={22} color={theme.accent} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Card style={{ gap: space.xs }}>
          <AppText variant="label" muted>REMOTE DIAGNOSTICS</AppText>
          <Row label="Connection" value={status?.enabled ? 'Configured' : 'Unavailable'} warning={!status?.enabled} />
          <Row label="Queued events" value={String(status?.pendingEvents ?? 0)} warning={(status?.pendingEvents ?? 0) > 100} />
          <Row label="Queued audio/files" value={String(status?.pendingArtifacts ?? 0)} />
          <Row label="Failed files" value={String(status?.failedArtifacts ?? 0)} warning={(status?.failedArtifacts ?? 0) > 0} />
          <Row
            label="Last upload"
            value={status?.lastUploadAt ? new Date(status.lastUploadAt).toLocaleString() : 'Not yet'}
          />
          <Row label="Diagnostic ID" value={status?.installId?.slice(0, 12) ?? '—'} />
          {status?.lastError ? <AppText variant="label" color={theme.warn}>{status.lastError}</AppText> : null}
        </Card>

        <Card style={{ gap: space.xs }}>
          <AppText variant="label" muted>CAPTURE</AppText>
          <Row label="Foreground recorder" value={isRecordingForegroundServiceRunning() ? 'Running' : 'Idle'} />
          <Row label="On-device speech" value={supportsOnDevice() ? 'Available' : 'Unavailable'} warning={!supportsOnDevice()} />
          <Row label="Offline models" value={locales.length ? locales.join(', ') : 'None reported'} warning={!locales.length} />
          <Row label="Audio inputs" value={inputs.length ? inputs.join(' · ') : 'None reported'} warning={!inputs.length} />
        </Card>

        <Card style={{ gap: space.xs }}>
          <AppText variant="label" muted>BUILD</AppText>
          <Row label="Version" value={Constants.expoConfig?.version ?? 'unknown'} />
          <Row label="Native build" value={Constants.nativeBuildVersion ?? 'unknown'} />
          <Row label="Device" value={`${Device.manufacturer ?? ''} ${Device.modelName ?? ''}`.trim()} />
          <Row label="Android" value={Device.osVersion ?? 'unknown'} />
        </Card>

        <AppText variant="label" muted style={{ textAlign: 'center' }}>
          Maina keeps a private local outbox when offline. You normally do not need to copy or share logs.
        </AppText>
      </ScrollView>

      <View style={{ padding: space.lg }}>
        <PrimaryButton label={syncing ? 'Sync requested…' : 'Sync diagnostics now'} onPress={forceSync} />
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
  content: { padding: space.lg, gap: space.lg },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: space.xs },
  value: { flex: 1, textAlign: 'right' },
});

import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { getOfflineLocales, supportsOnDevice } from '@/core/transcription/nativeSpeech';
import { purgeStagingMeetings } from '@/data/meetings';
import { AppText, Card, PrimaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { isRecordingForegroundServiceRunning, listAudioInputs } from '@/hardware/recording/foreground';
import {
  flushDiagnostics,
  getDiagnosticsStatus,
  purgeDiagnosticsData,
  retryFailedDiagnosticArtifacts,
} from '@/services/remoteLog';
import { isSentryConfigured } from '@/services/sentry';
import { formatStorageBytes, getStorageSnapshot } from '@/services/storageBudget';
import type { DiagnosticsStatus } from '../../../modules/maina-recorder/src';

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
  const { topPadding, contentBottomPadding, insets } = useMainaLayout();
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);
  const [locales, setLocales] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [storage, setStorage] = useState<{ availableBytes: number; totalBytes: number } | null>(null);

  const refresh = useCallback(async () => {
    const [nextStatus, audioInputs, languageState, storageSnapshot] = await Promise.all([
      getDiagnosticsStatus().catch(() => null),
      listAudioInputs().catch(() => []),
      getOfflineLocales().catch(() => ({ installed: [], supported: [] })),
      getStorageSnapshot().catch(() => null),
    ]);
    setStatus(nextStatus);
    setInputs(audioInputs.map((input) => `${input.type}: ${input.name}`));
    setLocales(languageState.installed);
    setStorage(storageSnapshot);
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

  const retryFailed = async () => {
    setSyncing(true);
    try {
      await retryFailedDiagnosticArtifacts();
      setTimeout(() => void refresh(), 1500);
    } finally {
      setSyncing(false);
    }
  };

  const clearStagingMeetings = () => {
    if (isRecordingForegroundServiceRunning()) {
      Alert.alert('Recording protected', 'Finish the active meeting before purging staging data.');
      return;
    }
    Alert.alert('Clear staging meetings?', 'This removes all non-active test meetings and their local audio folders.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          setSyncing(true);
          try {
            const deleted = await purgeStagingMeetings();
            await Promise.all(
              deleted
                .map((meeting) => meeting.audioUri)
                .filter((uri): uri is string => !!uri)
                .map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})),
            );
            await refresh();
          } finally {
            setSyncing(false);
          }
        },
      },
    ]);
  };

  const clearDiagnosticCache = () => {
    if (isRecordingForegroundServiceRunning()) {
      Alert.alert('Recording protected', 'Finish the active meeting before purging diagnostic artifacts.');
      return;
    }
    Alert.alert('Clear diagnostic cache?', 'This removes queued diagnostic files and native outbox records kept for staging analysis.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          setSyncing(true);
          try {
            await purgeDiagnosticsData();
            await refresh();
          } finally {
            setSyncing(false);
          }
        },
      },
    ]);
  };

  return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.topbar, { paddingTop: topPadding }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </Pressable>
        <AppText variant="heading">System status</AppText>
        <Pressable onPress={() => void refresh()} hitSlop={12}>
          <Ionicons name="refresh" size={22} color={theme.accent} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}>
        <Card style={{ gap: space.xs }}>
          <AppText variant="label" muted>REMOTE DIAGNOSTICS</AppText>
          <Row label="Connection" value={status?.enabled ? 'Configured' : 'Unavailable'} warning={!status?.enabled} />
          <Row label="Queued events" value={String(status?.pendingEvents ?? 0)} warning={(status?.pendingEvents ?? 0) > 100} />
          <Row label="Queued audio/files" value={String(status?.pendingArtifacts ?? 0)} />
          <Row label="Failed files" value={String(status?.failedArtifacts ?? 0)} warning={(status?.failedArtifacts ?? 0) > 0} />
          <Row
            label="Retry limit reached"
            value={String(status?.exhaustedArtifacts ?? 0)}
            warning={(status?.exhaustedArtifacts ?? 0) > 0}
          />
          <Row
            label="Oldest queued item"
            value={status?.oldestPendingAt ? new Date(status.oldestPendingAt).toLocaleString() : 'None'}
          />
          <Row
            label="Last failed attempt"
            value={status?.lastAttemptAt ? new Date(status.lastAttemptAt).toLocaleString() : 'None'}
          />
          <Row
            label="Last upload"
            value={status?.lastUploadAt ? new Date(status.lastUploadAt).toLocaleString() : 'Not yet'}
          />
          <Row label="Diagnostic ID" value={status?.installId?.slice(0, 12) ?? '—'} />
          <Row
            label="Retained audio"
            value={formatStorageBytes(status?.retainedAudioBytes ?? 0)}
          />
          <Row
            label="Native free space"
            value={status?.freeStorageBytes ? formatStorageBytes(status.freeStorageBytes) : 'Unknown'}
            warning={(status?.freeStorageBytes ?? Number.MAX_SAFE_INTEGER) < 1024 * 1024 * 1024}
          />
          <Row
            label="Crash / ANR reporting"
            value={isSentryConfigured() ? 'Sentry configured' : 'Waiting for Sentry DSN'}
            warning={!isSentryConfigured()}
          />
          {status?.lastError ? <AppText variant="label" color={theme.warn}>{status.lastError}</AppText> : null}
        </Card>

        <Card style={{ gap: space.xs }}>
          <AppText variant="label" muted>CAPTURE</AppText>
          <Row label="Foreground protection" value={isRecordingForegroundServiceRunning() ? 'Running' : 'Idle'} />
          <Row label="Audio owner" value="Native speech recorder" />
          <Row label="Endurance guarantee" value="Pending 2-hour device test" warning />
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
          <Row
            label="Free space"
            value={storage ? formatStorageBytes(storage.availableBytes) : 'Unknown'}
            warning={(storage?.availableBytes ?? Number.MAX_SAFE_INTEGER) < 1024 * 1024 * 1024}
          />
          <Row
            label="Disk capacity"
            value={storage ? formatStorageBytes(storage.totalBytes) : 'Unknown'}
          />
        </Card>

        <AppText variant="label" muted style={{ textAlign: 'center' }}>
          Maina keeps a private local outbox when offline. You normally do not need to copy or share logs.
        </AppText>
      </ScrollView>

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: insets.bottom + space.lg, gap: space.sm }}>
        {(status?.failedArtifacts ?? 0) > 0 ? (
          <PrimaryButton
            label={syncing ? 'Retry requested…' : 'Retry failed uploads'}
            onPress={retryFailed}
          />
        ) : null}
        <PrimaryButton
          label={syncing ? 'Working…' : 'Clear old staging meetings'}
          onPress={clearStagingMeetings}
        />
        <PrimaryButton
          label={syncing ? 'Working…' : 'Clear diagnostic cache'}
          onPress={clearDiagnosticCache}
        />
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
    paddingBottom: space.sm,
  },
  content: { padding: space.lg, gap: space.lg },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: space.xs },
  value: { flex: 1, textAlign: 'right' },
});

import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { getOfflineLocales, supportsOnDevice } from '@/core/transcription/nativeSpeech';
import { purgeStagingMeetings } from '@/data/meetings';
import { AppText, Banner, Card, PrimaryButton, SectionLabel } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { getNativeCaptureStatusAsync, getQwenAsrStatus, isRecordingForegroundServiceRunning, listAudioInputs } from '@/hardware/recording/foreground';
import {
  flushDiagnostics,
  getDiagnosticsStatus,
  purgeDiagnosticsData,
  retryFailedDiagnosticArtifacts,
} from '@/services/remoteLog';
import { isSentryConfigured } from '@/services/sentry';
import { formatStorageBytes, getStorageSnapshot } from '@/services/storageBudget';
import type { DiagnosticsStatus, NativeCaptureStatus, QwenAsrStatus } from '../../../modules/maina-recorder/src';

function Row({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  const { theme } = useAppTheme();
  return (
    <View style={styles.row}>
      <AppText variant="bodyStrong">{label}</AppText>
      <AppText variant="meta" color={warning ? theme.warn : theme.textSoft} style={styles.value}>{value}</AppText>
    </View>
  );
}

export default function Diagnostics() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);
  const [locales, setLocales] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [storage, setStorage] = useState<{ availableBytes: number; totalBytes: number } | null>(null);
  const [nativeCapture, setNativeCapture] = useState<NativeCaptureStatus | null>(null);
  const [qwen, setQwen] = useState<QwenAsrStatus | null>(null);

  const refresh = useCallback(async () => {
    const [nextStatus, audioInputs, languageState, storageSnapshot, captureStatus, qwenStatus] = await Promise.all([
      getDiagnosticsStatus().catch(() => null),
      listAudioInputs().catch(() => []),
      getOfflineLocales().catch(() => ({ installed: [], supported: [] })),
      getStorageSnapshot().catch(() => null),
      getNativeCaptureStatusAsync().catch(() => null),
      Platform.OS === 'ios' ? getQwenAsrStatus().catch(() => null) : Promise.resolve(null),
    ]);
    setStatus(nextStatus);
    setInputs(audioInputs.map((input) => `${input.type}: ${input.name}`));
    setLocales(languageState.installed);
    setStorage(storageSnapshot);
    setNativeCapture(captureStatus);
    setQwen(qwenStatus);
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
      <TopBar
        title="System status"
        back
        right={(
          <Pressable onPress={() => void refresh()} hitSlop={12}>
            <Ionicons name="refresh" size={22} color={theme.primary} />
          </Pressable>
        )}
      />

      <ScrollView contentContainerStyle={[styles.content, { paddingTop: topPadding, paddingBottom: contentBottomPadding }]}>
        <Banner tone={(status?.failedArtifacts ?? 0) > 0 || !status?.enabled ? 'warn' : 'info'} style={{ gap: 8 }}>
          <AppText variant="title">Diagnostics overview</AppText>
          <AppText variant="body" muted>
            This screen is for troubleshooting the local app state, uploads, storage, and capture environment. You normally do not need to copy logs manually.
          </AppText>
        </Banner>

        <Card style={{ gap: space.sm }}>
          <SectionLabel>Remote diagnostics</SectionLabel>
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
          {status?.lastError ? <AppText variant="body" color={theme.warn}>{status.lastError}</AppText> : null}
        </Card>

        <Card style={{ gap: space.sm }}>
          <SectionLabel>Capture</SectionLabel>
          <Row
            label="Recording state"
            value={Platform.OS === 'ios' ? (nativeCapture?.state ?? 'idle') : (isRecordingForegroundServiceRunning() ? 'running' : 'idle')}
          />
          <Row label="Audio owner" value="Native speech recorder" />
          <Row
            label="On-device transcription"
            value={Platform.OS === 'ios' ? (qwen?.ready ? 'Ready' : 'Setup needed') : (supportsOnDevice() ? 'Available' : 'Unavailable')}
            warning={Platform.OS === 'ios' ? !qwen?.ready : !supportsOnDevice()}
          />
          {Platform.OS === 'android' ? <Row label="Offline models" value={locales.length ? locales.join(', ') : 'None reported'} warning={!locales.length} /> : null}
          <Row label="Audio inputs" value={inputs.length ? inputs.join(' · ') : 'None reported'} warning={!inputs.length} />
        </Card>

        <Card style={{ gap: space.sm }}>
          <SectionLabel>Build</SectionLabel>
          <Row label="Version" value={Constants.expoConfig?.version ?? 'unknown'} />
          <Row label="Native build" value={Constants.nativeBuildVersion ?? 'unknown'} />
          <Row label="Device" value={`${Device.manufacturer ?? ''} ${Device.modelName ?? ''}`.trim()} />
          <Row label="Operating system" value={`${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`.trim()} />
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

        <Card style={{ gap: space.md }}>
          <SectionLabel>Actions</SectionLabel>
          {(status?.failedArtifacts ?? 0) > 0 ? (
            <PrimaryButton
              label={syncing ? 'Retry requested...' : 'Retry failed uploads'}
              onPress={retryFailed}
            />
          ) : null}
          <PrimaryButton
            label={syncing ? 'Working...' : 'Clear old staging meetings'}
            onPress={clearStagingMeetings}
          />
          <PrimaryButton
            label={syncing ? 'Working...' : 'Clear diagnostic cache'}
            onPress={clearDiagnosticCache}
          />
          <PrimaryButton label={syncing ? 'Sync requested...' : 'Sync diagnostics now'} onPress={forceSync} />
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: space.xl, gap: space.xl },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: space.xs },
  value: { flex: 1, textAlign: 'right' },
});

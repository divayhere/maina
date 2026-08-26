import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { FlashList } from '@shopify/flash-list';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { chooseRecognitionLanguage, startFileSession, stopSession, supportsOnDevice } from '@/core/transcription/nativeSpeech';
import { appendWithoutOverlap } from '@/core/transcription/transcript';
import {
  commitTranscriptFinalBlocks,
  createManualTodo,
  deleteMeeting,
  deleteTodo,
  getMeeting,
  getTranscriptPage,
  getTranscriptSummary,
  listMeetingTodos,
  listKnowledgeCloudCorrections,
  listRecordingSegments,
  resetMeetingTranscript,
  setMeetingSummaryState,
  type Meeting,
  type KnowledgeCloudCorrection,
  type RecordingSegment,
  type TodoItem,
  type TranscriptBlock,
  updateTodoDone,
  updateMeeting,
} from '@/data/meetings';
import { AppText, Banner, Card, Chip, PrimaryButton, SectionLabel } from '@/design/components';
import { TopBar } from '@/design/shell';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { inspectNativeCaptureDirectory, repairWavFiles } from '@/hardware/recording/foreground';
import { segmentPath } from '@/hardware/recording/paths';
import { maybeQueueMainaKnowledgeCloudSync } from '@/services/mainaKnowledgeCloud';
import { describeMainaKnowledgeCloudSyncStatus } from '@/services/mainaKnowledgeCloudCore';
import {
  requeueMainaKnowledgeCloudCorrectionsForMeeting,
} from '@/services/mainaKnowledgeCloudCorrections';
import { maybeQueueMeetingPacket, runMeetingPacketGeneration } from '@/services/meetingPacket';
import { log } from '@/services/logger';
import { ensureStorageBudget } from '@/services/storageBudget';
import { retryNativeMeetingTranscription } from '@/services/meetingCaptureLifecycle';
import { buildMeetingExportText, shareMeetingExport } from '@/services/transcriptExport';
import { useMeetings } from '@/state/meetingsStore';
import { formatDate, formatDuration, formatTime } from '@/utils/format';

const PAGE_SIZE = 60;

type MeetingTab = 'overview' | 'transcript';

function formatMeetingLength(meeting: Pick<Meeting, 'durationMs' | 'audioDurationMs'>): string {
  const elapsedMs = Math.max(0, meeting.durationMs);
  const recordedMs = Math.max(0, meeting.audioDurationMs ?? 0);
  if (recordedMs > 0 && Math.abs(elapsedMs - recordedMs) >= 5_000) {
    return `${formatDuration(recordedMs)} recorded · ${formatDuration(elapsedMs)} elapsed`;
  }
  return formatDuration(recordedMs || elapsedMs);
}

function TranscriptRow({ block }: { block: TranscriptBlock }) {
  const { theme } = useAppTheme();
  return (
    <View style={styles.blockRow}>
      <AppText variant="meta" muted>
        {block.startedAt ? formatTime(block.startedAt) : block.status === 'draft' ? 'Live draft' : 'Transcript'}
        {block.language ? ` · ${block.language}` : ''}
      </AppText>
      <AppText variant="body" color={block.status === 'draft' ? theme.textSoft : undefined}>
        {block.text}
      </AppText>
    </View>
  );
}

function ActionLink({
  label,
  color,
  onPress,
  disabled,
}: {
  label: string;
  color: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={8}>
      <AppText variant="bodyStrong" color={disabled ? '#90A1A1' : color}>{label}</AppText>
    </Pressable>
  );
}

function TabChip({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.segmentTab,
        {
          borderColor: active ? theme.primary : 'transparent',
          backgroundColor: active ? theme.primary : 'transparent',
        },
      ]}
    >
      <AppText variant="heading" color={active ? theme.primaryForeground : theme.textSoft}>{label}</AppText>
    </Pressable>
  );
}

function TodoPreviewRow({
  todo,
  onToggle,
  onDelete,
}: {
  todo: TodoItem;
  onToggle: (value: boolean) => void;
  onDelete: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
      <Pressable
        onPress={() => onToggle(!todo.done)}
        hitSlop={8}
        style={{
          width: 48,
          height: 48,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            borderWidth: 2,
            borderColor: todo.done ? theme.primary : theme.border,
            backgroundColor: todo.done ? theme.primary : theme.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {todo.done ? <Ionicons name="checkmark" size={14} color="#fff" /> : null}
        </View>
      </Pressable>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText
          variant="body"
          style={{ color: todo.done ? theme.textSoft : theme.text }}
        >
          {todo.text}
        </AppText>
        <AppText variant="meta" muted>{todo.origin === 'manual' ? 'Manual' : 'AI extracted'}</AppText>
      </View>
      {todo.origin === 'manual' ? (
        <Pressable onPress={onDelete} hitSlop={8}>
          <Ionicons name="close-outline" size={18} color={theme.textSoft} />
        </Pressable>
      ) : null}
    </View>
  );
}

function formatPacketError(message?: string | null): string {
  const normalized = message?.trim() ?? '';
  if (!normalized) return 'Notes are temporarily unavailable. Maina will retry safely.';
  return normalized;
}

export default function MeetingDetail() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topBarHeight } = useMainaLayout();
  const { id, allowInterrupted, startRepass: startRepassParam } = useLocalSearchParams<{
    id: string;
    allowInterrupted?: string;
    startRepass?: string;
  }>();
  const { refresh } = useMeetings();

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [blocks, setBlocks] = useState<TranscriptBlock[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [repassing, setRepassing] = useState(false);
  const [repassIdx, setRepassIdx] = useState(0);
  const [repassError, setRepassError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copyingTranscript, setCopyingTranscript] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [transcriptSummary, setTranscriptSummary] = useState<Awaited<ReturnType<typeof getTranscriptSummary>> | null>(null);
  const [tab, setTab] = useState<MeetingTab>('overview');
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [manualTodo, setManualTodo] = useState('');
  const [packetBusy, setPacketBusy] = useState(false);
  const [cloudCorrections, setCloudCorrections] = useState<KnowledgeCloudCorrection[]>([]);

  const repassRef = useRef(false);
  const repassChainRef = useRef<Promise<void>>(Promise.resolve());
  const idxRef = useRef(0);
  const meetingRef = useRef<Meeting | null>(null);
  const langRef = useRef('');
  const segmentsRef = useRef<RecordingSegment[]>([]);
  const errorRef = useRef<string | null>(null);
  const retriesRef = useRef<Record<number, number>>({});
  const repassTailRef = useRef('');
  const autoRepassHandledRef = useRef(false);

  const hasCompleteTranscript = meeting?.status === 'transcribed'
    || meeting?.status === 'summarizing'
    || meeting?.status === 'summarized';
  const packetError = useMemo(() => formatPacketError(meeting?.lastError), [meeting?.lastError]);
  const cloudState = useMemo(
    () =>
      describeMainaKnowledgeCloudSyncStatus({
        status: meeting?.knowledgeCloudSyncStatus ?? 'local_only',
        error: meeting?.knowledgeCloudError,
      }),
    [meeting?.knowledgeCloudError, meeting?.knowledgeCloudSyncStatus],
  );
  const cloudCorrectionState = useMemo(() => {
    if (cloudCorrections.length === 0) return null;
    const failed = cloudCorrections.find((item) => item.syncStatus.startsWith('sync_failed') || item.syncStatus === 'sync_blocked_budget');
    const pending = cloudCorrections.find((item) => item.syncStatus === 'sync_queued' || item.syncStatus === 'syncing');
    if (failed) {
      return {
        label: 'Notes update needs attention',
        detail: failed.error ?? 'The meeting is safe on this phone. Retry the cloud update when ready.',
        tone: 'warn' as const,
        canRetry: ![
          'sync_failed_auth',
          'sync_failed_conflict',
          'sync_failed_validation',
        ].includes(failed.syncStatus),
      };
    }
    if (pending) {
      return {
        label: 'Updating cloud notes',
        detail: 'Maina is adding the latest version of your notes without replacing the original meeting.',
        tone: 'muted' as const,
        canRetry: true,
      };
    }
    return {
      label: 'Latest notes synced',
      detail: 'The latest notes version is safely linked to the original meeting.',
      tone: 'primary' as const,
      canRetry: false,
    };
  }, [cloudCorrections]);

  const loadTranscript = useCallback(async (meetingId: string) => {
    const [page, summary] = await Promise.all([
      getTranscriptPage(meetingId, { offset: 0, limit: PAGE_SIZE, includeDraft: true }),
      getTranscriptSummary(meetingId),
    ]);
    setBlocks(page.blocks);
    setHasMore(page.hasMore);
    setOffset(page.blocks.length);
    setTranscriptSummary(summary);
  }, []);

  const load = useCallback(() => {
    if (!id) return;
    getMeeting(id).then(async (initialMeeting) => {
      let m = initialMeeting;
      if (m?.status === 'transcribed' && m.summaryStatus === 'idle') {
        await maybeQueueMeetingPacket(m.id).catch((cause) => {
          log.warn('summary', 'meeting detail auto-summary handoff failed', {
            meetingId: m?.id,
            err: String(cause),
          });
        });
        m = await getMeeting(id);
      }
      setMeeting(m);
      meetingRef.current = m;
      if (!m) return;
      if (m.status === 'interrupted' && allowInterrupted !== '1') {
        router.replace(`/meeting/${m.id}/recover`);
        return;
      }
      await Promise.all([
        loadTranscript(m.id),
        listMeetingTodos(m.id).then(setTodos),
        listKnowledgeCloudCorrections(m.id).then(setCloudCorrections),
      ]);
      if (!m.audioUri || m.segmentCount === 0) {
        setAudioAvailable(false);
        return;
      }
      const rows = await listRecordingSegments(m.id);
      const uris = rows.length > 0
        ? rows.map((segment) => segment.audioUri)
        : Array.from({ length: m.segmentCount }, (_, index) => segmentPath(m.audioUri!, index));
      // Native capture files live in Maina's private app storage. Expo's file
      // API cannot reliably stat those URIs, even though the native recorder
      // can still read and reprocess them. Prefer the native inspector so a
      // recoverable transcript always exposes its recovery action.
      const nativeInspection = await inspectNativeCaptureDirectory(m.audioUri, true).catch(() => null);
      if (nativeInspection) {
        setAudioAvailable(nativeInspection.finalizedUris.length > 0);
        return;
      }
      const checks = await Promise.all(uris.map((uri) => FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }))));
      setAudioAvailable(checks.length > 0 && checks.every((info) => info.exists));
    });
  }, [allowInterrupted, id, loadTranscript]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        load();
        refresh();
      }
    });
    return () => subscription.remove();
  }, [load, refresh]);

  useEffect(() => {
    if (!meeting) return;
    const packetPending = meeting.status === 'transcribing'
      || meeting.summaryStatus === 'queued'
      || meeting.summaryStatus === 'running';
    const sourceSyncPending = meeting.knowledgeCloudSyncStatus === 'sync_queued'
      || meeting.knowledgeCloudSyncStatus === 'syncing';
    const correctionSyncPending = cloudCorrections.some(
      (correction) => correction.syncStatus === 'sync_queued' || correction.syncStatus === 'syncing',
    );
    if (!packetPending && !sourceSyncPending && !correctionSyncPending) return;
    const timer = setTimeout(() => {
      load();
      refresh();
    }, 1500);
    return () => clearTimeout(timer);
  }, [cloudCorrections, load, meeting, refresh]);

  const loadMore = useCallback(async () => {
    if (!id || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getTranscriptPage(id, { offset, limit: PAGE_SIZE, includeDraft: true });
      setBlocks((current) => [...current, ...page.blocks]);
      setOffset((current) => current + page.blocks.length);
      setHasMore(page.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, id, loadingMore, offset]);

  const queueRepassFinal = (text: string) => {
    if (!id) return Promise.resolve();
    const appended = appendWithoutOverlap(repassTailRef.current, text);
    if (!appended.trim()) return Promise.resolve();
    const segment = segmentsRef.current[idxRef.current];
    repassChainRef.current = repassChainRef.current
      .catch(() => {})
      .then(async () => {
        const saved = await commitTranscriptFinalBlocks({
          meetingId: id,
          text: appended,
          segmentIndex: segment?.index ?? idxRef.current,
          startedAt: segment?.startedAt ?? meetingRef.current?.startedAt ?? Date.now(),
          endedAt: Date.now(),
          language: langRef.current,
        });
        if (saved.length > 0) repassTailRef.current = saved[saved.length - 1].text;
      })
      .catch((cause) => {
        errorRef.current = String(cause);
        log.warn('meeting', 'saved-audio block commit failed', { err: String(cause), index: idxRef.current });
      });
    return repassChainRef.current;
  };

  useSpeechRecognitionEvent('result', (event) => {
    if (!repassRef.current) return;
    const text = event.results?.[0]?.transcript ?? '';
    if (!event.isFinal || !text) return;
    void queueRepassFinal(text);
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (!repassRef.current) return;
    errorRef.current = event.error;
    log.warn('meeting', 'saved-audio recognition error', {
      index: idxRef.current,
      code: event.error,
      nativeCode: event.code,
      message: event.message,
      uri: segmentsRef.current[idxRef.current]?.audioUri,
    });
  });

  async function finishRepass() {
    if (!id) return;
    await repassChainRef.current.catch(() => {});
    const summary = await getTranscriptSummary(id);
    await updateMeeting(id, {
      transcript: null,
      status: summary.hasText ? 'transcribed' : 'recorded',
      transcribedSegments: segmentsRef.current.length,
      lastError: null,
      summaryStatus: 'idle',
    });
    setTranscriptSummary(summary);
    log.info('meeting', 'saved-audio pass complete', {
      blockCount: summary.blockCount,
      wordCount: summary.wordCount,
      files: segmentsRef.current.length,
    });
    load();
    await refresh();
    if (summary.hasText) {
      void maybeQueueMeetingPacket(id).catch((cause) => {
        log.warn('summary', 'saved-audio auto packet queue failed', {
          meetingId: id,
          err: String(cause),
        });
      });
    }
  }

  useSpeechRecognitionEvent('end', () => {
    if (!repassRef.current) return;
    const m = meetingRef.current;
    if (!m) return;
    void repassChainRef.current.catch(() => {}).then(() => {
      if (errorRef.current) {
        const attempts = retriesRef.current[idxRef.current] ?? 0;
        if (attempts < 2) {
          retriesRef.current[idxRef.current] = attempts + 1;
          const retryIndex = idxRef.current;
          const code = errorRef.current;
          errorRef.current = null;
          log.info('meeting', 'retrying saved audio', { index: retryIndex, attempt: attempts + 1, code });
          setTimeout(() => {
            if (!repassRef.current) return;
            startFileSession({ uri: segmentsRef.current[retryIndex].audioUri, lang: langRef.current });
          }, 1000 * (attempts + 1));
          return;
        }
        const failedCode = errorRef.current;
        repassRef.current = false;
        setRepassing(false);
        setRepassError(`Part ${idxRef.current + 1} failed after 3 attempts (${failedCode}). The original transcript was kept.`);
        void updateMeeting(m.id, { status: 'transcribed', lastError: failedCode, transcribedSegments: 0 });
        return;
      }
      const next = idxRef.current + 1;
      if (next < segmentsRef.current.length) {
        idxRef.current = next;
        setRepassIdx(next);
        startFileSession({ uri: segmentsRef.current[next].audioUri, lang: langRef.current });
      } else {
        repassRef.current = false;
        setRepassing(false);
        void finishRepass();
      }
    });
  });

  const startRepass = async () => {
    const m = meetingRef.current;
    if (!m?.audioUri || m.segmentCount === 0) return;
    setRepassError(null);
    const storageDecision = await ensureStorageBudget('repass');
    if (!storageDecision.ok) {
      setRepassError(storageDecision.message ?? 'Maina needs more free space before retrying transcription.');
      return;
    }
    const nativeInspection = await inspectNativeCaptureDirectory(m.audioUri, true).catch(() => null);
    if (nativeInspection && nativeInspection.finalizedUris.length > 0) {
      setRepassing(true);
      setRepassIdx(0);
      await updateMeeting(m.id, { transcript: null, status: 'transcribing', transcribedSegments: 0, lastError: null });
      try {
        const started = await retryNativeMeetingTranscription(m.id);
        if (!started) throw new Error('Saved audio was not ready for the native transcription service.');
        setRepassError(null);
        await refresh();
        load();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setRepassError(`Local transcription failed safely: ${message}`);
        await updateMeeting(m.id, { status: 'recorded', lastError: message }).catch(() => {});
      } finally {
        setRepassing(false);
      }
      return;
    }
    if (!supportsOnDevice()) {
      setRepassError('On-device speech is unavailable. Maina refused to upload the meeting audio.');
      return;
    }
    langRef.current = await chooseRecognitionLanguage();
    let segments = await listRecordingSegments(m.id);
    if (segments.length === 0) {
      segments = Array.from({ length: m.segmentCount }, (_, index) => ({
        meetingId: m.id,
        index,
        audioUri: segmentPath(m.audioUri!, index),
        startedAt: m.startedAt,
        status: 'recorded' as const,
      }));
    }
    await repairWavFiles(segments.map((segment) => segment.audioUri));
    const fileChecks = await Promise.all(segments.map(async (segment) => {
      const info = await FileSystem.getInfoAsync(segment.audioUri).catch(() => ({ exists: false }));
      return {
        index: segment.index,
        uri: segment.audioUri,
        exists: info.exists,
        size: info.exists && 'size' in info ? info.size : null,
      };
    }));
    const missing = fileChecks.filter((file) => !file.exists || !file.size);
    log.info('meeting', 'saved-audio preflight', {
      meetingId: m.id,
      files: fileChecks,
      missing: missing.length,
    });
    if (missing.length > 0) {
      setAudioAvailable(false);
      setRepassError('The recovery audio is no longer on this phone, so Maina could not retry transcription.');
      await updateMeeting(m.id, { audioUri: null });
      load();
      return;
    }
    await resetMeetingTranscript(m.id);
    setBlocks([]);
    setHasMore(false);
    setOffset(0);
    setTranscriptSummary({
      source: 'empty',
      blockCount: 0,
      wordCount: 0,
      charCount: 0,
      latestSequence: null,
      hasDraft: false,
      hasText: false,
    });
    segmentsRef.current = segments;
    idxRef.current = 0;
    errorRef.current = null;
    retriesRef.current = {};
    repassTailRef.current = '';
    setRepassIdx(0);
    repassRef.current = true;
    setRepassing(true);
    await updateMeeting(m.id, { transcript: null, status: 'transcribing', transcribedSegments: 0, lastError: null });
    log.info('meeting', 'saved-audio pass started', { files: segments.length, lang: langRef.current });
    startFileSession({ uri: segments[0].audioUri, lang: langRef.current });
  };

  useEffect(() => {
    if (startRepassParam !== '1' || autoRepassHandledRef.current || !meeting || repassing) return;
    if (meeting.status === 'interrupted' && allowInterrupted !== '1') return;
    autoRepassHandledRef.current = true;
    void startRepass();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowInterrupted, meeting, repassing, startRepassParam]);

  const cancelRepass = () => {
    repassRef.current = false;
    setRepassing(false);
    stopSession();
    const m = meetingRef.current;
    if (m) void updateMeeting(m.id, { status: 'recorded' });
  };

  const copyText = async (label: string, text: string) => {
    if (!text.trim()) return;
    await Clipboard.setStringAsync(text.trim());
    Alert.alert('Copied', `${label} is on your clipboard.`);
  };

  const copyTranscript = async () => {
    if (!meeting) return;
    setCopyingTranscript(true);
    try {
      const built = await buildMeetingExportText(meeting);
      await Clipboard.setStringAsync(built.transcriptText || built.text);
      Alert.alert('Copied', 'The transcript text is on your clipboard.');
    } finally {
      setCopyingTranscript(false);
    }
  };

  const shareMeeting = async () => {
    if (!meeting) return;
    const storageDecision = await ensureStorageBudget('export');
    if (!storageDecision.ok) {
      Alert.alert('More space needed', storageDecision.message ?? 'Maina needs more space before exporting this meeting.');
      return;
    }
    setSharing(true);
    try {
      await shareMeetingExport(meeting);
    } finally {
      setSharing(false);
    }
  };

  const deleteAudio = async () => {
    if (!id || !meeting?.audioUri) return;
    await FileSystem.deleteAsync(meeting.audioUri, { idempotent: true }).catch(() => {});
    await updateMeeting(id, { audioUri: null });
    load();
  };

  const confirmDelete = () => {
    Alert.alert('Delete this recording?', "The audio, text, notes and to-dos are removed from this phone. This can't be undone.", [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!id) return;
          if (meeting?.audioUri) {
            await FileSystem.deleteAsync(meeting.audioUri, { idempotent: true }).catch(() => {});
          }
          await deleteMeeting(id);
          await refresh();
          router.back();
        },
      },
    ]);
  };

  const generatePacket = async () => {
    if (!meeting || !id) return;
    setPacketBusy(true);
    try {
      await setMeetingSummaryState(id, 'queued');
      await runMeetingPacketGeneration(id, { regenerate: meeting.summaryStatus === 'ready' });
      await refresh();
      load();
    } finally {
      setPacketBusy(false);
    }
  };

  const addManualTodo = async () => {
    if (!meeting || !manualTodo.trim()) return;
    await createManualTodo(meeting.id, manualTodo);
    setManualTodo('');
    load();
    await refresh();
  };

  const queueCloudSync = async () => {
    if (!id) return;
    await maybeQueueMainaKnowledgeCloudSync(id);
    await requeueMainaKnowledgeCloudCorrectionsForMeeting(id, { includeAuthFailures: true });
    await refresh();
    load();
  };

  const header = (
    <View style={{ gap: space.xl, paddingHorizontal: 16, paddingTop: space.xl, paddingBottom: space.xl }}>
      {meeting ? (
        <View style={{ gap: 8 }}>
          <AppText variant="meta" muted>
            {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)} · {formatMeetingLength(meeting)}
            {meeting.language ? ` · ${meeting.language}` : ''}
          </AppText>
          <Chip
            label={
              meeting.summaryStatus === 'ready'
                ? 'Notes ready'
                : meeting.summaryStatus === 'running' || meeting.summaryStatus === 'queued'
                  ? 'Writing your notes'
                  : meeting.status === 'transcribing'
                    ? 'Getting the text ready'
                    : meeting.status === 'transcript_partial'
                      ? 'Transcript needs recovery'
                      : meeting.status === 'audio_expired_incomplete'
                        ? 'Partial transcript saved'
                    : meeting.status === 'interrupted'
                      ? 'Recording was cut short'
                      : transcriptSummary?.hasText
                        ? 'Transcript saved'
                        : 'Audio saved'
            }
            tone={
              meeting.summaryStatus === 'failed'
                || meeting.status === 'interrupted'
                || meeting.status === 'transcript_partial'
                || meeting.status === 'audio_expired_incomplete'
                ? 'warn'
                : meeting.summaryStatus === 'ready'
                  ? 'primary'
                  : 'muted'
            }
          />
        </View>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          gap: 4,
          borderRadius: radius.pill,
          backgroundColor: theme.mutedSoft,
          padding: 4,
        }}
      >
        <View style={{ flex: 1 }}>
          <TabChip active={tab === 'overview'} label="Notes" onPress={() => setTab('overview')} />
        </View>
        <View style={{ flex: 1 }}>
          <TabChip active={tab === 'transcript'} label="Transcript" onPress={() => setTab('transcript')} />
        </View>
      </View>
    </View>
  );

  if (tab === 'transcript') {
    const hasText = transcriptSummary?.hasText ?? false;
    const hasAudio = !!meeting?.audioUri && meeting.segmentCount > 0 && audioAvailable;
    return (
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: theme.bg }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={topBarHeight}
      >
        <TopBar title={meeting?.title ?? 'Meeting'} back />
        <FlashList
          data={blocks}
          keyExtractor={(item) => item.blockId}
          renderItem={({ item }) => <TranscriptRow block={item} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          drawDistance={400}
          ListHeaderComponent={
            <View>
              {header}
              <View style={{ gap: space.lg, paddingHorizontal: 16, paddingBottom: space.lg }}>
                <Card style={{ gap: space.md }}>
                  <SectionLabel>Transcript</SectionLabel>
                  {!hasText && !repassing ? (
                    <AppText variant="body" muted>No transcript blocks are saved for this recording yet.</AppText>
                  ) : null}
                  {repassing ? (
                    <Banner tone="info" style={{ gap: space.md }}>
                      <View style={styles.busy}>
                        <ActivityIndicator color={theme.primary} />
                        <AppText variant="body" muted style={{ flex: 1 }}>
                          Re-reading saved audio... part {repassIdx + 1}/{meeting?.segmentCount ?? 1}
                        </AppText>
                      </View>
                      <ActionLink label="Stop" color={theme.primary} onPress={cancelRepass} />
                    </Banner>
                  ) : hasAudio ? (
                    <ActionLink
                      label={hasText ? 'Re-transcribe from saved audio' : 'Transcribe from saved audio'}
                      color={theme.primary}
                      onPress={() => void startRepass()}
                    />
                  ) : null}
                  {repassError ? <AppText variant="body" color={theme.warn}>{repassError}</AppText> : null}
                  <View style={{ flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' }}>
                    <ActionLink label={copyingTranscript ? 'Copying...' : 'Copy transcript'} color={theme.primary} onPress={() => void copyTranscript()} />
                    <ActionLink label={sharing ? 'Preparing...' : 'Save a copy'} color={theme.primary} onPress={() => void shareMeeting()} />
                  </View>
                </Card>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
                  <View style={[styles.audioTag, { borderColor: theme.border, backgroundColor: theme.mutedSoft }]}>
                    <Ionicons
                      name={hasText ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                      size={16}
                      color={hasText ? theme.primary : theme.warn}
                    />
                    <AppText variant="meta" muted>
                      {hasText ? `${transcriptSummary?.blockCount ?? blocks.length} transcript blocks` : 'No transcript'}
                      {hasAudio ? ' · audio kept' : ''}
                    </AppText>
                  </View>
                  {hasAudio ? (
                    <ActionLink label="Delete audio" color={theme.textSoft} onPress={() => void deleteAudio()} />
                  ) : null}
                </View>
              </View>
            </View>
          }
          ListEmptyComponent={
            <View style={{ paddingHorizontal: 16, paddingBottom: space.xl }}>
              <AppText variant="body" muted>Maina will show timestamped transcript blocks here once they exist.</AppText>
            </View>
          }
          ListFooterComponent={loadingMore ? <View style={{ padding: space.lg }}><ActivityIndicator color={theme.primary} /></View> : null}
          contentContainerStyle={{ paddingBottom: contentBottomPadding }}
        />
      </KeyboardAvoidingView>
    );
  }

  const overviewSections = [
    'summary',
    'cloud',
    'decisions',
    'questions',
    'todos',
    'meta',
  ] as const;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={topBarHeight}
    >
      <TopBar title={meeting?.title ?? 'Meeting'} back />
      <FlashList
        data={overviewSections}
        keyExtractor={(item) => item}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: contentBottomPadding, paddingHorizontal: 16 }}
        renderItem={({ item }) => {
          if (item === 'summary') {
            return (
              <Card style={{ gap: space.md, marginBottom: space.lg }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md }}>
                  <AppText variant="title">Notes</AppText>
                  <View style={{ flexDirection: 'row', gap: space.lg, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <ActionLink label="Copy summary" color={theme.primary} onPress={() => void copyText('Summary', meeting?.summary ?? '')} disabled={!meeting?.summary} />
                    <ActionLink label={sharing ? 'Preparing...' : 'Save a copy'} color={theme.primary} onPress={() => void shareMeeting()} />
                  </View>
                </View>
                {packetBusy || meeting?.summaryStatus === 'queued' || meeting?.summaryStatus === 'running' ? (
                  <Banner tone="info" style={{ gap: space.md }}>
                    <View style={styles.busy}>
                      <ActivityIndicator color={theme.primary} />
                      <AppText variant="body" muted style={{ flex: 1 }}>
                        This usually takes a few minutes. You can leave this screen.
                      </AppText>
                    </View>
                  </Banner>
                ) : meeting?.summaryStatus === 'failed' ? (
                  <Banner tone="warn" style={{ gap: space.md }}>
                    <AppText variant="bodyStrong">Notes didn&apos;t come through</AppText>
                    <AppText variant="body" color={theme.warn}>
                      {packetError === 'No transcript text was available for summary generation.'
                        ? 'There was no text to work from.'
                        : packetError}
                    </AppText>
                    <View style={{ gap: space.md }}>
                      <PrimaryButton label="Try again" onPress={() => void generatePacket()} />
                    </View>
                  </Banner>
                ) : meeting?.summary ? (
                  <AppText variant="body">{meeting.summary}</AppText>
                ) : (
                  <Banner tone="info" style={{ gap: space.md }}>
                    <AppText variant="title">{transcriptSummary?.hasText ? 'Transcript saved' : 'Audio saved'}</AppText>
                    <AppText variant="body" muted>
                      {!transcriptSummary?.hasText
                        ? 'No words were saved yet. You can retry from the Transcript tab while the audio is still on this phone.'
                        : 'Maina will write notes automatically once this phone is connected to Maina Cloud.'}
                    </AppText>
                    {transcriptSummary?.hasText && hasCompleteTranscript ? (
                      <PrimaryButton
                        label="Write my notes"
                        onPress={() => void generatePacket()}
                      />
                    ) : null}
                  </Banner>
                )}
              </Card>
            );
          }

          if (item === 'decisions') {
            return (
              <Card style={{ gap: space.md, marginBottom: space.lg }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <AppText variant="heading">What was decided</AppText>
                  <ActionLink
                    label="Copy decisions"
                    color={theme.primary}
                    disabled={!meeting?.decisions.length}
                    onPress={() => void copyText('Decisions', (meeting?.decisions ?? []).map((decision) => `- ${decision}`).join('\n'))}
                  />
                </View>
                {meeting?.decisions.length ? (
                  <View style={{ gap: space.sm }}>
                    {meeting.decisions.map((decision) => (
                      <View key={decision} style={{ flexDirection: 'row', gap: space.sm }}>
                        <AppText variant="body" color={theme.primary}>•</AppText>
                        <AppText variant="body" style={{ flex: 1 }}>{decision}</AppText>
                      </View>
                    ))}
                  </View>
                ) : (
                  <AppText variant="body" muted>No decisions were extracted yet.</AppText>
                )}
              </Card>
            );
          }

          if (item === 'cloud') {
            const hasTranscriptForCloud = transcriptSummary?.hasText === true && hasCompleteTranscript;
            const canRetryMeetingCloud = hasTranscriptForCloud && (
              meeting?.knowledgeCloudSyncStatus === 'local_only'
              || meeting?.knowledgeCloudSyncStatus === 'sync_failed_retryable'
              || meeting?.knowledgeCloudSyncStatus === 'sync_blocked_budget'
            );
            const canRetryCloud = canRetryMeetingCloud
              || cloudCorrectionState?.canRetry === true;
            const needsCloudSettings = meeting?.knowledgeCloudSyncStatus === 'sync_failed_auth'
              || cloudCorrections.some((correction) => correction.syncStatus === 'sync_failed_auth');
            const visibleCloudState = cloudCorrectionState ?? cloudState;

            if (meeting?.knowledgeCloudSyncStatus === 'sync_succeeded' && !cloudCorrectionState) {
              return null;
            }
            return (
              <Card style={{ gap: space.md, marginBottom: space.lg }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md }}>
                  <AppText variant="heading">Maina Knowledge Cloud</AppText>
                  <Chip
                    label={visibleCloudState.label}
                    tone={
                      visibleCloudState.tone === 'warn'
                        ? 'warn'
                        : visibleCloudState.tone === 'primary'
                          ? 'primary'
                          : 'muted'
                    }
                  />
                </View>
                <AppText variant="body" muted>
                  {hasTranscriptForCloud || cloudCorrectionState
                    ? visibleCloudState.detail
                    : transcriptSummary?.hasText
                      ? 'Cloud sync waits until every recoverable audio window has been transcribed.'
                      : 'Cloud sync becomes available after Maina has saved transcript text.'}
                </AppText>
                {canRetryCloud ? (
                  <View style={{ gap: space.md }}>
                    <PrimaryButton
                      label={meeting?.knowledgeCloudSyncStatus === 'local_only' ? 'Sync this meeting now' : 'Retry cloud sync'}
                      onPress={() => void queueCloudSync()}
                    />
                  </View>
                ) : null}
                {needsCloudSettings ? <AppText variant="meta" color={theme.warn}>Reconnect Maina Cloud in Settings. Your local meeting is safe.</AppText> : null}
              </Card>
            );
          }

          if (item === 'questions') {
            return (
              <Card style={{ gap: space.md, marginBottom: space.lg }}>
                <AppText variant="heading">Still open</AppText>
                {meeting?.openQuestions.length ? (
                  <View style={{ gap: space.sm }}>
                    {meeting.openQuestions.map((question) => (
                      <View key={question} style={{ flexDirection: 'row', gap: space.sm }}>
                        <AppText variant="body" color={theme.warn}>?</AppText>
                        <AppText variant="body" style={{ flex: 1 }}>{question}</AppText>
                      </View>
                    ))}
                  </View>
                ) : (
                  <AppText variant="body" muted>No unresolved questions were extracted yet.</AppText>
                )}
              </Card>
            );
          }

          if (item === 'todos') {
            return (
              <Card style={{ gap: space.md, marginBottom: space.lg }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <AppText variant="heading">To-Dos</AppText>
                  <ActionLink label="Open all" color={theme.primary} onPress={() => router.push('/todos')} />
                </View>
                <View style={{ gap: space.md }}>
                  {todos.length ? todos.map((todo) => (
                    <TodoPreviewRow
                      key={todo.id}
                      todo={todo}
                      onToggle={(value) => void updateTodoDone(todo.id, value).then(() => load()).then(() => refresh())}
                      onDelete={() => void deleteTodo(todo.id).then(() => load()).then(() => refresh())}
                    />
                  )) : <AppText variant="body" muted>No to-dos yet.</AppText>}
                </View>
                <View style={{ gap: space.sm }}>
                  <TextInput
                    value={manualTodo}
                    onChangeText={setManualTodo}
                    placeholder="Add your own next step"
                    placeholderTextColor={theme.textSoft}
                    style={{
                      borderWidth: 1,
                      borderColor: theme.border,
                      borderRadius: radius.md,
                      backgroundColor: theme.surface,
                      color: theme.text,
                      paddingHorizontal: 16,
                      paddingVertical: space.md,
                    }}
                  />
                  <PrimaryButton label="Add to-do" onPress={() => void addManualTodo()} />
                </View>
              </Card>
            );
          }

          return (
            <Card style={{ gap: space.md, marginBottom: space.lg }}>
              <AppText variant="heading">Save & manage</AppText>
              <View style={{ flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' }}>
                <ActionLink label={copyingTranscript ? 'Copying...' : 'Copy transcript'} color={theme.primary} onPress={() => void copyTranscript()} />
                <ActionLink label={sharing ? 'Preparing...' : 'Save a copy'} color={theme.primary} onPress={() => void shareMeeting()} />
                <ActionLink label="Write notes again" color={theme.primary} onPress={() => void generatePacket()} disabled={packetBusy || meeting?.summaryStatus === 'running'} />
                <ActionLink label="Delete this recording" color={theme.destructive} onPress={confirmDelete} />
              </View>
            </Card>
          );
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  blockRow: {
    gap: space.sm,
    paddingHorizontal: 16,
    paddingBottom: space.lg,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  segmentTab: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});

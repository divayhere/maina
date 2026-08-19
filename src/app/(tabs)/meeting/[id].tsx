import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { FlashList } from '@shopify/flash-list';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';

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
  listRecordingSegments,
  resetMeetingTranscript,
  setMeetingSummaryState,
  type Meeting,
  type RecordingSegment,
  type TodoItem,
  type TranscriptBlock,
  updateTodoDone,
  updateMeeting,
} from '@/data/meetings';
import { AppText, Card, PrimaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { repairWavFiles } from '@/hardware/recording/foreground';
import { segmentPath } from '@/hardware/recording/paths';
import { chooseSummaryProviderLabel } from '@/services/meetingPacketMeta';
import { maybeQueueMeetingPacket, runMeetingPacketGeneration } from '@/services/meetingPacket';
import { log } from '@/services/logger';
import { ensureStorageBudget } from '@/services/storageBudget';
import { buildMeetingExportText, shareMeetingExport } from '@/services/transcriptExport';
import { useMeetings } from '@/state/meetingsStore';
import { formatDateTime, formatDuration, formatTime } from '@/utils/format';

const PAGE_SIZE = 60;

type MeetingTab = 'overview' | 'transcript';

function TranscriptRow({ block }: { block: TranscriptBlock }) {
  const { theme } = useAppTheme();
  return (
    <View style={styles.blockRow}>
      <AppText variant="label" muted>
        {block.startedAt ? formatTime(block.startedAt) : block.status === 'draft' ? 'Live draft' : 'Transcript'}
        {block.language ? ` · ${block.language}` : ''}
      </AppText>
      <AppText variant="body" color={block.status === 'draft' ? theme.muted : undefined}>
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
      <AppText variant="label" color={disabled ? '#8b86a6' : color}>{label}</AppText>
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
      style={{
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: active ? theme.accent : theme.border,
        backgroundColor: active ? theme.accentWash : theme.surface,
      }}
    >
      <AppText variant="label" color={active ? theme.accent : theme.text}>{label}</AppText>
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
          width: 24,
          height: 24,
          borderRadius: 12,
          borderWidth: 1.5,
          borderColor: todo.done ? theme.done : theme.border,
          backgroundColor: todo.done ? theme.done : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        {todo.done ? <Ionicons name="checkmark" size={14} color="#fff" /> : null}
      </Pressable>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="body" style={{ textDecorationLine: todo.done ? 'line-through' : 'none' }}>
          {todo.text}
        </AppText>
        <AppText variant="label" muted>{todo.origin === 'manual' ? 'Manual' : 'AI extracted'}</AppText>
      </View>
      {todo.origin === 'manual' ? (
        <Pressable onPress={onDelete} hitSlop={8}>
          <Ionicons name="close-outline" size={18} color={theme.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function formatPacketError(message?: string | null): string {
  const normalized = message?.trim() ?? '';
  if (!normalized) return 'Packet generation failed. Check AI setup and retry.';
  const lower = normalized.toLowerCase();
  if (
    lower.includes('no longer available')
    || lower.includes('not_found')
    || (lower.includes('models/gemini') && lower.includes('update your code'))
  ) {
    return 'The saved Gemini model is no longer valid for this API key. Maina should refresh it automatically on retry, or you can re-save Gemini in Settings.';
  }
  return normalized;
}

export default function MeetingDetail() {
  const { theme } = useAppTheme();
  const { topPadding, contentBottomPadding } = useMainaLayout();
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

  const providerLabel = useMemo(() => chooseSummaryProviderLabel(meeting), [meeting]);
  const packetError = useMemo(() => formatPacketError(meeting?.lastError), [meeting?.lastError]);

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
    getMeeting(id).then(async (m) => {
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
      ]);
      if (!m.audioUri || m.segmentCount === 0) {
        setAudioAvailable(false);
        return;
      }
      const rows = await listRecordingSegments(m.id);
      const uris = rows.length > 0
        ? rows.map((segment) => segment.audioUri)
        : Array.from({ length: m.segmentCount }, (_, index) => segmentPath(m.audioUri!, index));
      const checks = await Promise.all(uris.map((uri) => FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }))));
      setAudioAvailable(checks.length > 0 && checks.every((info) => info.exists));
    });
  }, [allowInterrupted, id, loadTranscript]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (!meeting || !(meeting.summaryStatus === 'queued' || meeting.summaryStatus === 'running')) return;
    const timer = setTimeout(() => {
      load();
      refresh();
    }, 2500);
    return () => clearTimeout(timer);
  }, [load, meeting, refresh]);

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
    Alert.alert('Delete meeting?', 'This removes the meeting, its transcript and audio.', [
      { text: 'Cancel', style: 'cancel' },
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
      await runMeetingPacketGeneration(id);
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

  const header = (
    <View style={{ gap: space.lg, paddingHorizontal: space.lg, paddingTop: topPadding, paddingBottom: space.lg }}>
      <View style={styles.topbar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </Pressable>
        <Pressable onPress={confirmDelete} hitSlop={12}>
          <Ionicons name="trash-outline" size={22} color={theme.rec} />
        </Pressable>
      </View>

      <Card style={{ gap: space.md, backgroundColor: theme.accent, borderColor: theme.accent }}>
        <View style={{ gap: 4 }}>
          <AppText variant="title" color="#fff">{meeting?.title ?? 'Meeting'}</AppText>
          {meeting ? (
            <AppText variant="body" color="rgba(255,255,255,0.88)">
              {formatDateTime(meeting.startedAt)} · {formatDuration(meeting.durationMs)}
              {meeting.language ? ` · ${meeting.language}` : ''}
            </AppText>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <View style={styles.heroChip}>
            <AppText variant="label" color="#fff">
              {meeting?.summaryStatus === 'ready'
                ? 'Packet ready'
                : meeting?.summaryStatus === 'running' || meeting?.summaryStatus === 'queued'
                  ? 'Building packet'
                  : 'Transcript first'}
            </AppText>
          </View>
          <View style={styles.heroChip}>
            <AppText variant="label" color="#fff">{transcriptSummary?.blockCount ?? 0} transcript blocks</AppText>
          </View>
          <View style={styles.heroChip}>
            <AppText variant="label" color="#fff">{meeting?.openTodoCount ?? 0} open to-dos</AppText>
          </View>
        </View>
      </Card>

      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <TabChip active={tab === 'overview'} label="Overview" onPress={() => setTab('overview')} />
        <TabChip active={tab === 'transcript'} label="Transcript" onPress={() => setTab('transcript')} />
      </View>
    </View>
  );

  if (tab === 'transcript') {
    const hasText = transcriptSummary?.hasText ?? false;
    const hasAudio = !!meeting?.audioUri && meeting.segmentCount > 0 && audioAvailable;
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
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
              <View style={{ gap: space.lg, paddingHorizontal: space.lg, paddingBottom: space.lg }}>
                <Card style={{ gap: space.md }}>
                  <AppText variant="label" muted>TRANSCRIPT MEMORY</AppText>
                  {!hasText && !repassing ? (
                    <AppText variant="body" muted>No block transcript is saved for this meeting yet.</AppText>
                  ) : null}
                  {repassing ? (
                    <View style={styles.busy}>
                      <ActivityIndicator color={theme.accent} />
                      <AppText variant="body" muted style={{ flex: 1 }}>
                        Re-reading saved audio… part {repassIdx + 1}/{meeting?.segmentCount ?? 1}
                      </AppText>
                      <Pressable onPress={cancelRepass} hitSlop={8}>
                        <AppText variant="label" muted>stop</AppText>
                      </Pressable>
                    </View>
                  ) : hasAudio ? (
                    <ActionLink
                      label={hasText ? 'Re-transcribe from saved audio' : 'Transcribe from saved audio'}
                      color={theme.accent}
                      onPress={() => void startRepass()}
                    />
                  ) : null}
                  {repassError ? <AppText variant="body" color={theme.warn}>{repassError}</AppText> : null}
                  <View style={{ flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' }}>
                    <ActionLink label={copyingTranscript ? 'Copying…' : 'Copy transcript'} color={theme.accent} onPress={() => void copyTranscript()} />
                    <ActionLink label={sharing ? 'Preparing…' : 'Share meeting'} color={theme.accent} onPress={() => void shareMeeting()} />
                  </View>
                </Card>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
                  <View style={[styles.audioTag, { borderColor: theme.border }]}>
                    <Ionicons
                      name={hasText ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                      size={16}
                      color={hasText ? theme.done : theme.warn}
                    />
                    <AppText variant="label" muted>
                      {hasText ? `${transcriptSummary?.blockCount ?? blocks.length} transcript blocks` : 'No transcript'}
                      {hasAudio ? ' · audio kept' : ''}
                    </AppText>
                  </View>
                  {hasAudio ? (
                    <ActionLink label="Delete audio" color={theme.muted} onPress={() => void deleteAudio()} />
                  ) : null}
                </View>
              </View>
            </View>
          }
          ListEmptyComponent={
            <View style={{ paddingHorizontal: space.lg, paddingBottom: space.xl }}>
              <AppText variant="body" muted>Maina will show timestamped transcript blocks here once they exist.</AppText>
            </View>
          }
          ListFooterComponent={loadingMore ? <View style={{ padding: space.lg }}><ActivityIndicator color={theme.accent} /></View> : null}
          contentContainerStyle={{ paddingBottom: contentBottomPadding }}
        />
      </View>
    );
  }

  const overviewSections = ['summary', 'decisions', 'questions', 'todos', 'meta'] as const;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <FlashList
        data={overviewSections}
        keyExtractor={(item) => item}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: contentBottomPadding, paddingHorizontal: space.lg }}
        renderItem={({ item }) => {
          if (item === 'summary') {
            return (
              <Card style={{ gap: space.md, marginBottom: space.lg }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md }}>
                  <AppText variant="heading">Summary</AppText>
                  <View style={{ flexDirection: 'row', gap: space.lg, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <ActionLink label="Copy summary" color={theme.accent} onPress={() => void copyText('Summary', meeting?.summary ?? '')} disabled={!meeting?.summary} />
                    <ActionLink label={sharing ? 'Preparing…' : 'Share meeting'} color={theme.accent} onPress={() => void shareMeeting()} />
                  </View>
                </View>
                {packetBusy || meeting?.summaryStatus === 'queued' || meeting?.summaryStatus === 'running' ? (
                  <View style={styles.busy}>
                    <ActivityIndicator color={theme.accent} />
                    <AppText variant="body" muted style={{ flex: 1 }}>
                      Maina is building your meeting packet with {providerLabel}.
                    </AppText>
                  </View>
                ) : meeting?.summaryStatus === 'failed' ? (
                  <View style={{ gap: space.md }}>
                    <AppText variant="label" muted>Packet setup issue</AppText>
                    <AppText variant="body" color={theme.warn}>
                      {packetError}
                    </AppText>
                    <View style={{ gap: space.md }}>
                      <PrimaryButton label="Retry packet" onPress={() => void generatePacket()} />
                      <ActionLink label="Open AI settings" color={theme.accent} onPress={() => router.push('/settings')} />
                    </View>
                  </View>
                ) : meeting?.summary ? (
                  <AppText variant="body">{meeting.summary}</AppText>
                ) : (
                  <>
                    <AppText variant="body" muted>
                      No packet yet. Generate a packet when the transcript is ready, or let Maina do it automatically after the meeting.
                    </AppText>
                    <PrimaryButton label="Generate packet now" onPress={() => void generatePacket()} />
                  </>
                )}
              </Card>
            );
          }

          if (item === 'decisions') {
            return (
              <Card style={{ gap: space.md, marginBottom: space.lg }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <AppText variant="heading">Decisions</AppText>
                  <ActionLink
                    label="Copy decisions"
                    color={theme.accent}
                    disabled={!meeting?.decisions.length}
                    onPress={() => void copyText('Decisions', (meeting?.decisions ?? []).map((decision) => `- ${decision}`).join('\n'))}
                  />
                </View>
                {meeting?.decisions.length ? (
                  <View style={{ gap: space.sm }}>
                    {meeting.decisions.map((decision) => (
                      <View key={decision} style={{ flexDirection: 'row', gap: space.sm }}>
                        <AppText variant="body" color={theme.accent}>•</AppText>
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

          if (item === 'questions') {
            return (
              <Card style={{ gap: space.md, marginBottom: space.lg }}>
                <AppText variant="heading">Open Questions</AppText>
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
                  <ActionLink label="Open all" color={theme.accent} onPress={() => router.push('/todos')} />
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
                    placeholderTextColor={theme.muted}
                    style={{
                      borderWidth: 1,
                      borderColor: theme.border,
                      borderRadius: radius.lg,
                      backgroundColor: theme.surface,
                      color: theme.text,
                      paddingHorizontal: space.lg,
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
              <AppText variant="heading">Packet metadata</AppText>
              <AppText variant="body" muted>
                Provider: {providerLabel}
                {meeting?.summaryModel ? ` · ${meeting.summaryModel}` : ''}
              </AppText>
              <View style={{ flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' }}>
                <ActionLink label={copyingTranscript ? 'Copying…' : 'Copy transcript'} color={theme.accent} onPress={() => void copyTranscript()} />
                <ActionLink label="Rebuild packet" color={theme.accent} onPress={() => void generatePacket()} disabled={packetBusy || meeting?.summaryStatus === 'running'} />
              </View>
            </Card>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  topbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  heroChip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  blockRow: {
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  audioTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
});

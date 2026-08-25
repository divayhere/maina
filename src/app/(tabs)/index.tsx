import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, TextInput, View } from 'react-native';

import { AppText, Banner, Card, Chip, EmptyState, SectionLabel } from '@/design/components';
import { DrawerMenu } from '@/design/shell';
import { type Meeting } from '@/data/meetings';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { describeMainaKnowledgeCloudSyncStatus } from '@/services/mainaKnowledgeCloudCore';
import { countActionableNotifications } from '@/services/notifications';
import { useMeetings } from '@/state/meetingsStore';
import { formatDate, formatDuration, formatTime } from '@/utils/format';

function describeTranscriptionProgress(item: Meeting): { detail?: string; progress?: number } {
  if (item.transcriptionWindowCount > 0) {
    const completed = item.transcriptionCompletedWindows + item.transcriptionFailedWindows;
    const progress = Math.max(0, Math.min(1, completed / item.transcriptionWindowCount));
    return {
      detail: `${completed} of ${item.transcriptionWindowCount} audio windows · ${Math.round(progress * 100)}%`,
      progress,
    };
  }
  if (item.transcribedSegments > 0 && item.segmentCount > 0) {
    const progress = Math.max(0, Math.min(1, item.transcribedSegments / item.segmentCount));
    return {
      detail: `${item.transcribedSegments} of ${item.segmentCount} audio files complete`,
      progress,
    };
  }
  return {};
}

function describeState(item: Meeting): { label: string; tone: 'primary' | 'warn' | 'live' | 'muted'; detail?: string; working?: boolean; progress?: number } {
  if (item.status === 'recording') return { label: 'Recording now', tone: 'live', working: true };
  if (item.status === 'interrupted') return { label: 'Recording was cut short', tone: 'warn', detail: 'We saved what we could. Tap to fix.' };
  if (item.status === 'transcript_partial') return { label: 'Transcript needs recovery', tone: 'warn', detail: 'Some audio is still available for another transcription pass.' };
  if (item.status === 'audio_expired_incomplete') return { label: 'Partial transcript saved', tone: 'warn', detail: 'Recovery audio reached the storage limit and was removed.' };
  if (item.summaryStatus === 'failed') return { label: "Notes didn't come through", tone: 'warn', detail: 'Your transcript is safe.' };
  if (item.summaryStatus === 'ready') return { label: 'Notes ready', tone: 'primary' };
  if (item.summaryStatus === 'queued' || item.summaryStatus === 'running' || item.status === 'summarizing') {
    return { label: 'Writing your notes', tone: 'primary', working: true };
  }
  if (item.status === 'transcribing') {
    const progress = describeTranscriptionProgress(item);
    return {
      label: 'Getting the text ready',
      tone: 'primary',
      detail: progress.detail,
      working: true,
      progress: progress.progress,
    };
  }
  if (item.status === 'recorded') return { label: 'Saved', tone: 'muted', detail: 'Not written up yet.' };
  return { label: 'Transcript saved', tone: 'muted' };
}

function MeetingRow({ item }: { item: Meeting }) {
  const { theme } = useAppTheme();
  const state = describeState(item);
  const cloudState = describeMainaKnowledgeCloudSyncStatus({
    status: item.knowledgeCloudSyncStatus,
    error: item.knowledgeCloudError,
  });
  const meta = `${formatDate(item.startedAt)} · ${formatTime(item.startedAt)} · ${formatDuration(item.durationMs)}${item.language ? ` · ${item.language}` : ''}`;

  return (
    <Pressable onPress={() => router.push(item.status === 'interrupted' ? `/meeting/${item.id}/recover` : `/meeting/${item.id}`)}>
      {({ pressed }) => (
        <Card style={{ gap: space.lg, opacity: pressed ? 0.96 : 1 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.md }}>
            <View style={{ flex: 1, gap: 8 }}>
              <AppText variant="title" numberOfLines={2}>
                {item.title}
              </AppText>
              <AppText variant="meta" muted>
                {meta}
              </AppText>
            </View>
            <Ionicons name="chevron-forward" size={26} color={theme.textSoft} />
          </View>

          <Chip label={state.label} tone={state.tone} />

          {item.summaryStatus === 'ready' && item.summary?.trim() ? (
            <AppText variant="body" muted numberOfLines={2}>
              {item.summary.trim()}
            </AppText>
          ) : (
            <AppText variant="body" muted numberOfLines={2}>
              {state.detail ?? 'Transcript stays available as raw memory. Notes appear here once ready.'}
            </AppText>
          )}

          {item.knowledgeCloudSyncStatus !== 'local_only' ? (
            <AppText variant="meta" color={cloudState.tone === 'warn' ? theme.warn : cloudState.tone === 'primary' ? theme.primary : theme.textSoft}>
              {cloudState.label}
            </AppText>
          ) : null}

          {state.working ? (
            state.progress == null ? (
              <ActivityIndicator size="small" color={theme.primary} style={{ alignSelf: 'flex-start' }} />
            ) : (
              <View style={{ height: 6, borderRadius: radius.pill, backgroundColor: theme.mutedSoft, overflow: 'hidden' }}>
                <View style={{ width: `${state.progress * 100}%`, height: '100%', borderRadius: radius.pill, backgroundColor: theme.primary }} />
              </View>
            )
          ) : null}
        </Card>
      )}
    </Pressable>
  );
}

export default function MeetingsScreen() {
  const { theme } = useAppTheme();
  const { topPadding, contentBottomPadding } = useMainaLayout();
  const { meetings, refresh, loaded } = useMeetings();
  const [query, setQuery] = useState('');

  useFocusEffect(
    useCallback(() => {
      void refresh();
      const timer = setInterval(() => {
        void refresh();
      }, 3_000);
      return () => clearInterval(timer);
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return meetings;
    return meetings.filter((meeting) => meeting.title.toLowerCase().includes(needle));
  }, [meetings, query]);

  const interrupted = meetings.find((meeting) => meeting.status === 'interrupted');
  const notificationCount = countActionableNotifications(meetings);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <DrawerMenu />
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MeetingRow item={item} />}
        ItemSeparatorComponent={() => <View style={{ height: space.lg }} />}
        ListHeaderComponent={
          <View style={{ gap: space.lg, paddingTop: topPadding, marginBottom: space.lg }}>
            <View style={{ gap: 6 }}>
              <AppText variant="body" muted>
                Your ambient meeting memory stays on this phone first, then turns into usable notes when the transcript is ready.
              </AppText>
              <AppText variant="meta" muted>
                {meetings.length} recording{meetings.length === 1 ? '' : 's'} · {notificationCount} alert{notificationCount === 1 ? '' : 's'}
              </AppText>
            </View>
            {interrupted ? (
              <Pressable onPress={() => router.push(`/meeting/${interrupted.id}/recover`)}>
                <Banner tone="warn" style={{ gap: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                    <Ionicons name="alert-circle-outline" size={24} color={theme.warn} />
                    <AppText variant="title" style={{ flex: 1 }}>
                      A recording was cut short
                    </AppText>
                  </View>
                  <AppText variant="body" muted>
                    We saved what we could. Tap to fix it now.
                  </AppText>
                </Banner>
              </Pressable>
            ) : null}

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                borderRadius: radius.pill,
                backgroundColor: theme.mutedSoft,
                paddingHorizontal: 18,
                minHeight: 56,
              }}
            >
              <Ionicons name="search-outline" size={24} color={theme.textSoft} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search recording names"
                placeholderTextColor={theme.textSoft}
                style={{ flex: 1, color: theme.text, fontSize: 16 }}
              />
            </View>

            <SectionLabel>Recent</SectionLabel>
          </View>
        }
        ListEmptyComponent={
          loaded ? (
            query.trim() ? (
              <View style={{ paddingTop: 8 }}>
                <AppText variant="body" muted style={{ textAlign: 'center' }}>
                  No recording names match &quot;{query}&quot;.
                </AppText>
              </View>
            ) : (
              <Banner tone="info" style={{ alignItems: 'center', gap: 8, paddingVertical: 28 }}>
                <AppText variant="title">No recordings yet</AppText>
                <AppText variant="body" muted style={{ textAlign: 'center' }}>
                  Use the center mic button below to make your first one.
                </AppText>
              </Banner>
            )
          ) : (
            <EmptyState title="Loading your recordings" subtitle="Maina is opening your local library." />
          )
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: contentBottomPadding,
          flexGrow: 1,
        }}
      />
    </View>
  );
}

import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, TextInput, View } from 'react-native';

import { AppText, Banner, Card, Chip, EmptyState, SectionLabel } from '@/design/components';
import { DrawerMenu } from '@/design/shell';
import { type Meeting } from '@/data/meetings';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { describeMainaKnowledgeCloudSyncStatus } from '@/services/mainaKnowledgeCloudCore';
import { describeMeetingPresentation } from '@/services/meetingPresentation';
import { useMeetings } from '@/state/meetingsStore';
import { formatDate, formatDuration, formatTime } from '@/utils/format';
import { markdownToReadableText } from '@/utils/plainText';

function MeetingRow({ item }: { item: Meeting }) {
  const { theme } = useAppTheme();
  const state = describeMeetingPresentation(item);
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
              {markdownToReadableText(item.summary)}
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
  const [refreshing, setRefreshing] = useState(false);
  const pipelineActive = useMemo(
    () => meetings.some((meeting) => describeMeetingPresentation(meeting).working),
    [meetings],
  );

  useFocusEffect(
    useCallback(() => {
      void refresh();
      if (!pipelineActive) return undefined;
      const timer = setInterval(() => {
        void refresh();
      }, 2_000);
      return () => clearInterval(timer);
    }, [pipelineActive, refresh]),
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

  const refreshFromGesture = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <DrawerMenu />
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MeetingRow item={item} />}
        ItemSeparatorComponent={() => <View style={{ height: space.lg }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshFromGesture()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: space.lg, paddingTop: topPadding, marginBottom: space.lg }}>
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

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <SectionLabel>Recent</SectionLabel>
              <AppText variant="meta" muted>
                {meetings.length} recording{meetings.length === 1 ? '' : 's'}
              </AppText>
            </View>
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

import type { MeetingLibraryItem } from '@/contracts/mkc-release-a.generated';
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { MemoryError, MemoryFreshness, MemoryRow } from '@/components/memory/MemoryUi';
import { AppText, Banner, SecondaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { useMemoryResource } from '@/hooks/useMemoryResource';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';
import { memoryRouteForSource } from '@/services/mkc-memory-presentation';
import { listCloudMeetings } from '@/services/mkc-memory-release-a';

function CloudMeetingsList() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const load = useCallback((signal: AbortSignal) => listCloudMeetings({
    enabled: true, query: { sort: 'newest', pageSize: 40 }, signal,
  }), []);
  const state = useMemoryResource(load);
  const [items, setItems] = useState<MeetingLibraryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!state.result) return;
    setItems(state.result.data.meetings);
    setNextCursor(state.result.data.page.next_cursor);
  }, [state.result]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listCloudMeetings({ enabled: true, query: { sort: 'newest', pageSize: 40, cursor: nextCursor } });
      setItems((current) => [...current, ...page.data.meetings.filter((candidate) => !current.some((item) => item.source_key === candidate.source_key))]);
      setNextCursor(page.data.page.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title="Cloud meetings" back />
      <FlatList
        data={items}
        keyExtractor={(item) => item.source_key}
        renderItem={({ item }) => (
          <MemoryRow
            title={item.title || 'Untitled meeting'}
            body={item.summary_preview}
            meta={`${new Date(item.occurred_at).toLocaleString()} · ${item.readiness.replaceAll('_', ' ')} · ${item.counts.todos} to-dos`}
            onPress={() => router.push(memoryRouteForSource(item.source_key) as never)}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void state.refresh()} tintColor={theme.primary} colors={[theme.primary]} />}
        ListHeaderComponent={(
          <View style={{ paddingTop: topPadding, paddingBottom: space.lg, gap: space.md }}>
            <AppText variant="body" muted>Canonical meetings from every connected Maina device, newest first.</AppText>
            {state.result ? <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} /> : null}
            {state.error ? <MemoryError error={state.error} onRetry={() => void state.refresh()} /> : null}
          </View>
        )}
        ListEmptyComponent={!state.loading && !state.error ? <Banner tone="info"><AppText variant="body" muted>No cloud meetings match this view.</AppText></Banner> : null}
        ListFooterComponent={nextCursor ? <View style={{ paddingTop: space.lg }}><SecondaryButton label={loadingMore ? 'Loading…' : 'Load more'} disabled={loadingMore} onPress={() => void loadMore()} /></View> : null}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: contentBottomPadding, flexGrow: 1 }}
      />
    </View>
  );
}

export default function CloudMeetingsScreen() {
  if (!MKC_MEMORY_FEATURE_FLAGS.mobileMemorySurfaceV1 || !MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1) return <Redirect href="/memory" />;
  return <CloudMeetingsList />;
}

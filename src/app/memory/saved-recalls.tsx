import { Redirect, router } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Linking, RefreshControl, View } from 'react-native';

import { MemoryError, MemoryFreshness, MemoryRow } from '@/components/memory/MemoryUi';
import { AppText, Banner, Chip, SecondaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { useMemoryResource } from '@/hooks/useMemoryResource';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';
import { describeSmartRecallDelta, memoryRouteForSavedRecall } from '@/services/mkc-memory-presentation';
import { listSavedSmartRecalls } from '@/services/mkc-memory-releases';
import { buildMkcMemoryWebUrl } from '@/services/mkc-memory-web';

function SavedRecallsList() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const load = useCallback((signal: AbortSignal) => listSavedSmartRecalls({ enabled: true, signal }), []);
  const state = useMemoryResource(load);
  const items = state.result?.data.smart_recalls ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title="Saved Recalls" back />
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const delta = describeSmartRecallDelta(item.last_delta);
          return (
            <MemoryRow
              title={item.name}
              body={item.original_query}
              meta={item.last_search_id ? `Last run ${new Date(item.updated_at).toLocaleString()}` : 'Not run yet'}
              chip={<Chip label={delta.label} tone={delta.tone} />}
              onPress={() => router.push(memoryRouteForSavedRecall(item.id) as never)}
            />
          );
        }}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void state.refresh()} tintColor={theme.primary} colors={[theme.primary]} />}
        ListHeaderComponent={(
          <View style={{ paddingTop: topPadding, paddingBottom: space.lg, gap: space.md }}>
            <AppText variant="body" muted>Reusable evidence searches. Running or preparing one happens only when you tap.</AppText>
            {state.result ? <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} /> : null}
            {state.error ? <MemoryError error={state.error} onRetry={() => void state.refresh()} /> : null}
          </View>
        )}
        ListEmptyComponent={!state.loading && !state.error ? (
          <Banner tone="info" style={{ gap: space.md }}>
            <AppText variant="bodyStrong">No saved Recalls yet</AppText>
            <AppText variant="body" muted>Create and edit saved Recalls on Knowledge Cloud Web.</AppText>
            <SecondaryButton label="Create on Web" onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'saved-recalls' }))} />
          </Banner>
        ) : null}
        ListFooterComponent={items.length ? <View style={{ paddingTop: space.lg }}><SecondaryButton label="Create or edit on Web" onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'saved-recalls' }))} /></View> : null}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: contentBottomPadding, flexGrow: 1 }}
      />
    </View>
  );
}

export default function SavedRecallsScreen() {
  if (!MKC_MEMORY_FEATURE_FLAGS.mobileMemorySurfaceV1 || !MKC_MEMORY_FEATURE_FLAGS.mobileSavedRecallsV1) return <Redirect href="/memory" />;
  return <SavedRecallsList />;
}

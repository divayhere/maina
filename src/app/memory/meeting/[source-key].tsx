import type { MeetingDetailResponse, MeetingTranscriptUnit } from '@/contracts/mkc-release-a.generated';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, RefreshControl, Share, View } from 'react-native';

import { MemoryError, MemoryFreshness, MemorySection } from '@/components/memory/MemoryUi';
import { AppText, Banner, Card, Chip, SecondaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { useMemoryResource } from '@/hooks/useMemoryResource';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';
import { getCloudMeetingDetail, getCloudMeetingTranscriptPage } from '@/services/mkc-memory-release-a';
import { buildMkcMemoryWebUrl } from '@/services/mkc-memory-web';

function TextList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <AppText variant="body" muted>{empty}</AppText>;
  return <View style={{ gap: space.sm }}>{items.map((item, index) => <AppText key={`${index}:${item}`} variant="body" selectable>• {item}</AppText>)}</View>;
}

function CloudMeetingDetail({ sourceKey }: { sourceKey: string }) {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const load = useCallback(async (signal: AbortSignal) => {
    const detail = await getCloudMeetingDetail({ sourceKey, enabled: true, signal });
    const transcript = await getCloudMeetingTranscriptPage({
      sourceKey,
      transcriptSha256: detail.data.transcript.continuation.transcript_sha256,
      pageSize: 40,
      enabled: true,
      signal,
    });
    return {
      data: { detail: detail.data, transcript: transcript.data },
      source: detail.source === 'cache' || transcript.source === 'cache' ? 'cache' as const : 'network' as const,
      fetchedAt: Math.min(detail.fetchedAt, transcript.fetchedAt),
    };
  }, [sourceKey]);
  const state = useMemoryResource(load);
  const [blocks, setBlocks] = useState<MeetingTranscriptUnit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!state.result) return;
    setBlocks(state.result.data.transcript.units);
    setNextCursor(state.result.data.transcript.page.next_cursor);
  }, [state.result]);

  const detail: MeetingDetailResponse | null = state.result?.data.detail ?? null;
  const loadMore = async () => {
    if (!detail || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getCloudMeetingTranscriptPage({ sourceKey, transcriptSha256: detail.transcript.continuation.transcript_sha256, pageSize: 40, cursor: nextCursor, enabled: true });
      setBlocks((current) => [...current, ...page.data.units.filter((unit) => !current.some((item) => item.block_key === unit.block_key))]);
      setNextCursor(page.data.page.next_cursor);
    } finally { setLoadingMore(false); }
  };

  const share = async () => {
    if (!detail) return;
    await Share.share({ message: `${detail.title}\n\n${detail.summary ?? 'No summary available.'}\n\n${buildMkcMemoryWebUrl({ kind: 'meeting', sourceKey })}` });
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title={detail?.title ?? 'Cloud meeting'} back />
      <FlatList
        data={blocks}
        keyExtractor={(item) => item.block_key}
        renderItem={({ item }) => <Card style={{ gap: 4 }}><AppText variant="meta" muted>{item.kind.replaceAll('_', ' ')}</AppText><AppText variant="body" selectable>{item.text}</AppText></Card>}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void state.refresh()} tintColor={theme.primary} colors={[theme.primary]} />}
        ListHeaderComponent={(
          <View style={{ paddingTop: topPadding, paddingBottom: space.xxl, gap: space.xxl }}>
            {state.error ? <MemoryError error={state.error} onRetry={() => void state.refresh()} /> : null}
            {!detail && !state.error ? <Banner tone="info"><AppText variant="body" muted>Loading cloud meeting…</AppText></Banner> : null}
            {detail ? (
              <>
                <Card style={{ gap: space.md }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
                    <View style={{ flex: 1, gap: 6 }}>
                      <AppText variant="title">{detail.title}</AppText>
                      <AppText variant="body" muted>{new Date(detail.occurred_at).toLocaleString()} · {detail.provenance.platform ?? 'Maina app'}</AppText>
                    </View>
                    <Chip label={detail.readiness.replaceAll('_', ' ')} tone={detail.readiness === 'ready' ? 'primary' : 'warn'} />
                  </View>
                  {state.result ? <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} /> : null}
                </Card>
                <MemorySection title="Summary"><Card><AppText variant="body" selectable>{detail.summary ?? 'No summary is available yet.'}</AppText></Card></MemorySection>
                <MemorySection title="Decisions"><TextList items={detail.decisions} empty="No decisions were extracted." /></MemorySection>
                <MemorySection title="To-dos"><TextList items={detail.todos} empty="No to-dos were extracted." /></MemorySection>
                <MemorySection title="Open questions"><TextList items={detail.open_questions} empty="No open questions were extracted." /></MemorySection>
                <View style={{ gap: space.md }}>
                  <SecondaryButton label="Open on Web" onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'meeting', sourceKey }))} />
                  <SecondaryButton label="Share" onPress={() => void share()} />
                </View>
                <MemorySection title={`Transcript · ${detail.transcript.continuation.total_units} blocks`}>
                  <AppText variant="meta" muted>Loaded in verified pages; Maina does not render an unbounded transcript at once.</AppText>
                </MemorySection>
              </>
            ) : null}
          </View>
        )}
        ListFooterComponent={nextCursor ? <View style={{ paddingTop: space.lg }}><SecondaryButton label={loadingMore ? 'Loading…' : 'Load more transcript'} disabled={loadingMore} onPress={() => void loadMore()} /></View> : null}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: contentBottomPadding, flexGrow: 1 }}
      />
    </View>
  );
}

export default function CloudMeetingDetailScreen() {
  const params = useLocalSearchParams<{ 'source-key': string | string[] }>();
  const raw = params['source-key'];
  const sourceKey = Array.isArray(raw) ? raw[0] : raw;
  if (!MKC_MEMORY_FEATURE_FLAGS.mobileMemorySurfaceV1 || !MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1 || !sourceKey) return <Redirect href="/memory/meetings" />;
  return <CloudMeetingDetail sourceKey={sourceKey} />;
}

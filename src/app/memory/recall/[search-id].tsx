import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { Linking, ScrollView, Share, View } from 'react-native';

import { MemoryError, MemoryFreshness, MemorySection } from '@/components/memory/MemoryUi';
import { AppText, Banner, Card, Chip, SecondaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { useMemoryResource } from '@/hooks/useMemoryResource';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';
import { openFrozenRecall } from '@/services/mkc-memory-release-a';
import { buildMkcMemoryWebUrl } from '@/services/mkc-memory-web';

function FrozenRecall({ searchId }: { searchId: string }) {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const load = useCallback((signal: AbortSignal) => openFrozenRecall({ searchId, enabled: true, signal }), [searchId]);
  const state = useMemoryResource(load);
  const recall = state.result?.data;
  const share = async () => {
    if (!recall) return;
    await Share.share({ message: [
      `# Frozen Maina Recall`,
      recall.plan.original_query,
      `Search: ${recall.search_id}`,
      `Result SHA-256: ${recall.result_sha256}`,
      `Bundle SHA-256: ${recall.bundle_sha256}`,
      `Created: ${recall.created_at}`,
      `Expires: ${recall.expires_at}`,
      `Coverage: ${recall.coverage.returned_source_count}/${recall.coverage.scope_source_count} sources returned`,
      buildMkcMemoryWebUrl({ kind: 'recall', searchId }),
    ].join('\n\n') });
  };
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title="Frozen Recall" back />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: topPadding, paddingBottom: contentBottomPadding, gap: space.xxl }}>
        {state.error ? <MemoryError error={state.error} onRetry={() => void state.refresh()} /> : null}
        {!recall && !state.error ? <Banner tone="info"><AppText variant="body" muted>Opening exact frozen evidence…</AppText></Banner> : null}
        {recall ? (
          <>
            <Card style={{ gap: space.md }}>
              <AppText variant="title" selectable>{recall.plan.original_query}</AppText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                <Chip label={`${recall.source_count} sources`} tone="primary" />
                <Chip label={`${recall.fact_count} facts`} tone="muted" />
                <Chip label={recall.coverage.truncated ? 'Coverage truncated' : 'Coverage receipt'} tone={recall.coverage.truncated ? 'warn' : 'primary'} />
              </View>
              {state.result ? <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} /> : null}
              <AppText variant="meta" muted selectable>Search {recall.search_id}</AppText>
              <AppText variant="meta" muted selectable>Result {recall.result_sha256}</AppText>
              <AppText variant="meta" muted selectable>Bundle {recall.bundle_sha256}</AppText>
              <AppText variant="meta" muted>Expires {new Date(recall.expires_at).toLocaleString()}</AppText>
            </Card>
            {recall.coverage.warnings.length ? <Banner tone="warn" style={{ gap: 6 }}>{recall.coverage.warnings.map((warning) => <AppText key={warning} variant="body" muted>• {warning}</AppText>)}</Banner> : null}
            <MemorySection title="Evidence packet">
              <Card style={{ gap: space.sm }}>
                <AppText variant="body" selectable>{recall.source_manifest_markdown.slice(0, 4_000)}</AppText>
                {recall.source_manifest_markdown.length > 4_000 ? <AppText variant="meta" muted>Preview shortened on this phone. Open the exact frozen packet on Web for the complete manifest.</AppText> : null}
              </Card>
            </MemorySection>
            {recall.bundle.chapters.length ? (
              <MemorySection title="Available chapters">
                <Card style={{ gap: space.sm }}>{recall.bundle.chapters.map((chapter) => <AppText key={chapter.chapter_id} variant="body">• {chapter.title} · {chapter.source_count} sources</AppText>)}</Card>
              </MemorySection>
            ) : null}
            <SecondaryButton label="Open on Web" onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'recall', searchId }))} />
            <SecondaryButton label="Share exact identity" onPress={() => void share()} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

export default function FrozenRecallScreen() {
  const params = useLocalSearchParams<{ 'search-id': string | string[] }>();
  const raw = params['search-id'];
  const searchId = Array.isArray(raw) ? raw[0] : raw;
  if (!MKC_MEMORY_FEATURE_FLAGS.mobileMemorySurfaceV1 || !MKC_MEMORY_FEATURE_FLAGS.mobileFrozenHandoffV1 || !searchId) return <Redirect href="/memory" />;
  return <FrozenRecall searchId={searchId} />;
}

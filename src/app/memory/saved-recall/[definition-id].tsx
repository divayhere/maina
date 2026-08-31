import type { SmartRecallRunV1 } from '@/contracts/mkc-memory-releases.generated';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, ScrollView, Share, View } from 'react-native';

import { MemoryError, MemoryFreshness, MemoryRow, MemorySection } from '@/components/memory/MemoryUi';
import { AppText, Banner, Card, Chip, PrimaryButton, SecondaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { useMemoryResource } from '@/hooks/useMemoryResource';
import { smartRecallDeltaCount } from '@/services/mkc-memory-contract-core';
import { MkcMemoryReadError } from '@/services/mkc-memory-client';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';
import { describeSmartRecallDelta, memoryRouteForFrozenRecall } from '@/services/mkc-memory-presentation';
import { getSavedSmartRecall, prepareSavedSmartRecall, runSavedSmartRecall } from '@/services/mkc-memory-releases';
import { buildMkcMemoryWebUrl } from '@/services/mkc-memory-web';

function SavedRecallDetail({ definitionId }: { definitionId: string }) {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const load = useCallback((signal: AbortSignal) => getSavedSmartRecall({ definitionId, enabled: true, signal }), [definitionId]);
  const state = useMemoryResource(load);
  const [action, setAction] = useState<'run' | 'prepare' | null>(null);
  const [actionResult, setActionResult] = useState<SmartRecallRunV1 | null>(null);
  const [actionError, setActionError] = useState<MkcMemoryReadError | null>(null);
  const recall = actionResult?.smart_recall ?? state.result?.data;

  const execute = async (kind: 'run' | 'prepare') => {
    if (action) return;
    setAction(kind); setActionError(null);
    try {
      const result = kind === 'run'
        ? await runSavedSmartRecall({ definitionId, enabled: true })
        : await prepareSavedSmartRecall({ definitionId, enabled: true });
      setActionResult(result);
    } catch (cause) {
      setActionError(cause as MkcMemoryReadError);
    } finally {
      setAction(null);
    }
  };

  const shareFrozenIdentity = async (result: SmartRecallRunV1) => {
    const handoff = result.handoff;
    await Share.share({
      message: [
        `# ${result.smart_recall.name}`,
        result.smart_recall.original_query,
        `Search: ${result.run.search_id}`,
        `Result SHA-256: ${result.run.result_sha256}`,
        `Bundle SHA-256: ${result.run.bundle_sha256}`,
        `Coverage: ${result.run.coverage.returned_source_count}/${result.run.coverage.scope_source_count} sources returned`,
        handoff?.instruction ?? 'Open this exact frozen evidence packet in Maina Knowledge Cloud.',
        buildMkcMemoryWebUrl({ kind: 'recall', searchId: result.run.search_id }),
      ].join('\n\n'),
    });
  };

  const delta = recall ? describeSmartRecallDelta(recall.last_delta) : null;
  const latestDelta = actionResult?.delta ?? recall?.last_delta ?? null;
  const changedSources = latestDelta ? [
    ...latestDelta.new_sources.map((item) => ({ key: `new:${item.source_key}`, label: 'New source', sourceKey: item.source_key })),
    ...latestDelta.removed_sources.map((item) => ({ key: `removed:${item.source_key}`, label: 'Removed source', sourceKey: item.source_key })),
    ...latestDelta.revised_sources.map((item) => ({ key: `revised:${item.after.source_key}`, label: 'Revised source', sourceKey: item.after.source_key })),
  ] : [];
  const changedFacts = latestDelta ? [
    ...latestDelta.new_facts.map((item) => ({ key: `new:${item.identity}`, label: 'New fact', text: item.text, sourceKey: item.source_key })),
    ...latestDelta.removed_facts.map((item) => ({ key: `removed:${item.identity}`, label: 'Removed fact', text: item.text, sourceKey: item.source_key })),
    ...latestDelta.changed_decisions.map((item) => ({ key: `decision:${item.identity}`, label: 'Changed decision', text: item.text, sourceKey: item.source_key })),
    ...latestDelta.actions_opened.map((item) => ({ key: `opened:${item.identity}`, label: 'Action opened', text: item.text, sourceKey: item.source_key })),
    ...latestDelta.actions_completed.map((item) => ({ key: `completed:${item.identity}`, label: 'Action completed', text: item.text, sourceKey: item.source_key })),
    ...latestDelta.actions_cancelled.map((item) => ({ key: `cancelled:${item.identity}`, label: 'Action cancelled', text: item.text, sourceKey: item.source_key })),
    ...latestDelta.new_questions.map((item) => ({ key: `question:${item.identity}`, label: 'New question', text: item.text, sourceKey: item.source_key })),
    ...latestDelta.new_corrections.map((item) => ({ key: `correction:${item.identity}`, label: 'New correction', text: item.field_path, sourceKey: item.source_key })),
  ] : [];

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title={recall?.name ?? 'Saved Recall'} back />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: topPadding, paddingBottom: contentBottomPadding, gap: space.xxl }}>
        {state.error ? <MemoryError error={state.error} onRetry={() => void state.refresh()} /> : null}
        {!recall && !state.error ? <Banner tone="info"><AppText variant="body" muted>Loading saved Recall…</AppText></Banner> : null}
        {recall ? (
          <>
            <Card style={{ gap: space.md }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
                <View style={{ flex: 1, gap: 6 }}>
                  <AppText variant="title">{recall.name}</AppText>
                  <AppText variant="body" selectable>{recall.original_query}</AppText>
                </View>
                {delta ? <Chip label={delta.label} tone={delta.tone} /> : null}
              </View>
              {state.result ? <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} /> : null}
              <AppText variant="meta" muted selectable>Original filters: {JSON.stringify(recall.explicit_filters)}</AppText>
            </Card>

            {actionError ? <MemoryError error={actionError} onRetry={() => void execute('run')} /> : null}
            <View style={{ gap: space.md }}>
              <PrimaryButton label={action === 'run' ? 'Running…' : 'Run now'} disabled={!!action} loading={action === 'run'} onPress={() => void execute('run')} />
              <SecondaryButton label={action === 'prepare' ? 'Preparing…' : 'Prepare for meeting'} disabled={!!action} onPress={() => void execute('prepare')} />
              <SecondaryButton label="Open or edit on Web" onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'saved-recall', definitionId }))} />
            </View>

            {latestDelta ? (
              <MemorySection title="What changed">
                {!latestDelta.comparable_to_previous ? (
                  <Banner tone="warn" style={{ gap: space.sm }}>
                    <AppText variant="bodyStrong">Refresh baseline</AppText>
                    <AppText variant="body" muted>{latestDelta.comparability_reason === 'first_run' ? 'This is the first run, so there is no earlier result to compare.' : 'The planner or scope changed, so Maina will not show a misleading change count.'}</AppText>
                  </Banner>
                ) : (
                  <Card style={{ gap: space.sm }}>
                    <AppText variant="title">{smartRecallDeltaCount(latestDelta) ?? 0}</AppText>
                    <AppText variant="body" muted>Identity-based source, fact, correction, and action-status changes.</AppText>
                  </Card>
                )}
                {changedSources.map((item) => (
                  <MemoryRow key={item.key} title={item.label} meta={item.sourceKey} onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'source', sourceKey: item.sourceKey }))} />
                ))}
                {changedFacts.map((item) => (
                  <MemoryRow key={item.key} title={item.label} body={item.text} meta={item.sourceKey} onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'source', sourceKey: item.sourceKey }))} />
                ))}
              </MemorySection>
            ) : null}

            {actionResult ? (
              <MemorySection title="Frozen evidence">
                <Card style={{ gap: space.sm }}>
                  <AppText variant="bodyStrong">{actionResult.run.coverage.returned_source_count} sources returned</AppText>
                  <AppText variant="body" muted>{actionResult.run.coverage.warnings.length ? actionResult.run.coverage.warnings.join(' · ') : 'Coverage receipt contains no warnings.'}</AppText>
                  <AppText variant="meta" muted selectable>Search {actionResult.run.search_id}</AppText>
                </Card>
                <PrimaryButton label="Open exact evidence" onPress={() => router.push(memoryRouteForFrozenRecall(actionResult.run.search_id) as never)} />
                <SecondaryButton label="Share exact packet" onPress={() => void shareFrozenIdentity(actionResult)} />
              </MemorySection>
            ) : recall.last_search_id ? (
              <PrimaryButton label="Open latest frozen result" onPress={() => router.push(memoryRouteForFrozenRecall(recall.last_search_id!) as never)} />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

export default function SavedRecallDetailScreen() {
  const params = useLocalSearchParams<{ 'definition-id': string | string[] }>();
  const raw = params['definition-id'];
  const definitionId = Array.isArray(raw) ? raw[0] : raw;
  if (!MKC_MEMORY_FEATURE_FLAGS.mobileMemorySurfaceV1 || !MKC_MEMORY_FEATURE_FLAGS.mobileSavedRecallsV1 || !definitionId) return <Redirect href="/memory/saved-recalls" />;
  return <SavedRecallDetail definitionId={definitionId} />;
}

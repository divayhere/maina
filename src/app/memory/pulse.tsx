import type { MemoryPulseV1 } from '@/contracts/mkc-memory-releases.generated';
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { Linking, RefreshControl, ScrollView, View } from 'react-native';

import { MemoryError, MemoryFreshness, MemoryRow, MemorySection } from '@/components/memory/MemoryUi';
import { AppText, Banner, Card, Chip } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { useMemoryResource } from '@/hooks/useMemoryResource';
import { memoryPulseCoverageLabel } from '@/services/mkc-memory-contract-core';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';
import { memoryRouteForSource } from '@/services/mkc-memory-presentation';
import { getMemoryPulse, markMemoryPulseViewed } from '@/services/mkc-memory-releases';
import { buildMkcMemoryWebUrl } from '@/services/mkc-memory-web';

type PulseFact = MemoryPulseV1['recent']['decisions'][number];

function PulseFactRows({ facts }: { facts: PulseFact[] }) {
  if (facts.length === 0) return <AppText variant="body" muted>None found in the indexed evidence for this window.</AppText>;
  return (
    <View style={{ gap: space.md }}>
      {facts.map((fact) => (
        <MemoryRow
          key={fact.identity_key}
          title={fact.text}
          meta={`${fact.source_title} · ${new Date(fact.occurred_at).toLocaleDateString()}`}
          onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'source', sourceKey: fact.source_key }))}
        />
      ))}
    </View>
  );
}

function PulseContent() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const load = useCallback((signal: AbortSignal) => getMemoryPulse({ enabled: true, signal }), []);
  const state = useMemoryResource(load);
  const markedObservedAt = useRef<string | null>(null);

  useEffect(() => {
    const observedAt = state.result?.source === 'network' ? state.result.data.observed_at : null;
    if (!observedAt || markedObservedAt.current === observedAt) return;
    markedObservedAt.current = observedAt;
    void markMemoryPulseViewed({ observedAt, enabled: true }).catch(() => {
      // Viewing is a best-effort explicit owner action. It never creates a
      // durable mobile retry or hides the verified Pulse already on screen.
    });
  }, [state.result]);

  const pulse = state.result?.data;
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title="Memory Pulse" back />
      <ScrollView
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void state.refresh()} tintColor={theme.primary} colors={[theme.primary]} />}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: topPadding, paddingBottom: contentBottomPadding, gap: space.xxl }}
      >
        {state.error ? <MemoryError error={state.error} onRetry={() => void state.refresh()} /> : null}
        {!pulse && !state.error ? <Banner tone="info"><AppText variant="body" muted>Checking what changed…</AppText></Banner> : null}
        {pulse ? (
          <>
            <Card style={{ gap: space.md }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
                <View style={{ flex: 1, gap: 6 }}>
                  <AppText variant="title">Since {new Date(pulse.window.since).toLocaleString()}</AppText>
                  <AppText variant="body" muted>{pulse.window.basis === 'last_visit' ? 'Since your last successful check.' : 'Using the last seven days for this first view.'}</AppText>
                </View>
                <Chip label={memoryPulseCoverageLabel(pulse)} tone={pulse.commitments.coverage.warnings.length ? 'warn' : 'primary'} />
              </View>
              {state.result ? <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} /> : null}
            </Card>

            {pulse.commitments.coverage.warnings.length > 0 ? (
              <Banner tone="warn" style={{ gap: space.sm }}>
                <AppText variant="bodyStrong">Coverage is incomplete</AppText>
                {pulse.commitments.coverage.warnings.map((warning) => <AppText key={warning} variant="body" muted>• {warning}</AppText>)}
                <AppText variant="meta" muted>Maina will not claim there are no commitments when structured evidence is sparse.</AppText>
              </Banner>
            ) : null}

            <MemorySection title="Recent sources">
              {pulse.recent.meetings.length + pulse.recent.documents.length === 0 ? (
                <AppText variant="body" muted>No new indexed sources in this window.</AppText>
              ) : (
                <View style={{ gap: space.md }}>
                  {pulse.recent.meetings.map((source) => (
                    <MemoryRow
                      key={source.source_key}
                      title={source.title}
                      body={source.summary_text}
                      meta={`${source.source_type} · ${new Date(source.occurred_at).toLocaleString()}`}
                      onPress={() => router.push(memoryRouteForSource(source.source_key) as never)}
                    />
                  ))}
                  {pulse.recent.documents.map((source) => (
                    <MemoryRow
                      key={source.source_key}
                      title={source.title}
                      body={source.summary_text}
                      meta={`${source.source_type} · ${new Date(source.occurred_at).toLocaleString()}`}
                      onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'source', sourceKey: source.source_key }))}
                    />
                  ))}
                </View>
              )}
            </MemorySection>

            <MemorySection title={`Commitments · ${pulse.commitments.known_open_count} known open`}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                <Chip label={`${pulse.commitments.overdue_count} overdue`} tone={pulse.commitments.overdue_count ? 'warn' : 'muted'} />
                <Chip label={`${pulse.commitments.due_next_seven_days_count} due soon`} tone="muted" />
                <Chip label={`${pulse.commitments.without_owner_count} without owner`} tone="muted" />
                <Chip label={`${pulse.commitments.without_deadline_count} without deadline`} tone="muted" />
              </View>
              {[...pulse.commitments.overdue, ...pulse.commitments.due_next_seven_days].length === 0 ? (
                <AppText variant="body" muted>No dated open actions were found in the available structured evidence.</AppText>
              ) : (
                <View style={{ gap: space.md }}>
                  {[...pulse.commitments.overdue, ...pulse.commitments.due_next_seven_days].map((action) => (
                    <MemoryRow
                      key={`${action.identity_key}:${action.deadline_at ?? 'undated'}`}
                      title={action.text}
                      meta={`${action.source_title} · ${action.owner || 'Owner not stated'} · ${action.deadline || 'Deadline not stated'}`}
                      onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'source', sourceKey: action.source_key }))}
                    />
                  ))}
                </View>
              )}
            </MemorySection>

            <MemorySection title="Recent decisions"><PulseFactRows facts={pulse.recent.decisions} /></MemorySection>
            <MemorySection title="Open questions"><PulseFactRows facts={pulse.recent.open_questions} /></MemorySection>

            {pulse.recent.changed_decisions.length > 0 ? (
              <MemorySection title="Changed decisions">
                <View style={{ gap: space.md }}>
                  {pulse.recent.changed_decisions.map((item) => (
                    <MemoryRow key={item.correction_key} title={item.body} meta={`${item.source_title} · corrected ${new Date(item.corrected_at).toLocaleString()}`} onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'source', sourceKey: item.source_key }))} />
                  ))}
                </View>
              </MemorySection>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

export default function MemoryPulseScreen() {
  if (!MKC_MEMORY_FEATURE_FLAGS.mobileMemorySurfaceV1 || !MKC_MEMORY_FEATURE_FLAGS.mobileMemoryPulseV1) return <Redirect href="/memory" />;
  return <PulseContent />;
}

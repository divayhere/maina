import { Ionicons } from '@expo/vector-icons';
import { Redirect, router } from 'expo-router';
import { useCallback } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';

import { MemoryError, MemoryFreshness, MemoryRow, MemorySection } from '@/components/memory/MemoryUi';
import { AppText, Banner, Card, Chip, SecondaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { DrawerMenu } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { useMemoryResource } from '@/hooks/useMemoryResource';
import { listCloudMeetings } from '@/services/mkc-memory-release-a';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';
import {
  MKC_MEMORY_ROUTES,
  describeSmartRecallDelta,
  memoryRouteForSavedRecall,
  memoryRouteForSource,
} from '@/services/mkc-memory-presentation';
import { getMemoryPulse, listSavedSmartRecalls } from '@/services/mkc-memory-releases';
import { buildMkcMemoryWebUrl } from '@/services/mkc-memory-web';

function MeetingsPreview() {
  const load = useCallback((signal: AbortSignal) => listCloudMeetings({
    enabled: true, query: { sort: 'newest', pageSize: 3 }, signal,
  }), []);
  const state = useMemoryResource(load);
  if (state.error) return <MemoryError error={state.error} onRetry={() => void state.refresh()} />;
  if (!state.result) return <Banner tone="info"><AppText variant="body" muted>Loading recent cloud meetings…</AppText></Banner>;
  return (
    <View style={{ gap: space.md }}>
      <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} />
      {state.result.data.meetings.length === 0 ? (
        <Banner tone="info"><AppText variant="body" muted>No cloud meetings yet.</AppText></Banner>
      ) : state.result.data.meetings.map((meeting) => (
        <MemoryRow
          key={meeting.source_key}
          title={meeting.title || 'Untitled meeting'}
          body={meeting.summary_preview}
          meta={`${new Date(meeting.occurred_at).toLocaleString()} · ${meeting.readiness.replaceAll('_', ' ')}`}
          onPress={() => router.push(memoryRouteForSource(meeting.source_key) as never)}
        />
      ))}
    </View>
  );
}

function PulsePreview() {
  const load = useCallback((signal: AbortSignal) => getMemoryPulse({ enabled: true, signal }), []);
  const state = useMemoryResource(load);
  if (state.error) return <MemoryError error={state.error} onRetry={() => void state.refresh()} />;
  if (!state.result) return <Banner tone="info"><AppText variant="body" muted>Loading Pulse…</AppText></Banner>;
  const pulse = state.result.data;
  const warningCount = pulse.commitments.coverage.warnings.length;
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push(MKC_MEMORY_ROUTES.pulse)}>
      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.md }}>
          <View style={{ flex: 1, gap: 6 }}>
            <AppText variant="bodyStrong">What needs attention</AppText>
            <AppText variant="body" muted>
              {pulse.recent.meetings.length + pulse.recent.documents.length} new sources · {pulse.commitments.known_open_count} known open actions
            </AppText>
          </View>
          <Chip label={warningCount > 0 ? `${warningCount} coverage note${warningCount === 1 ? '' : 's'}` : 'Evidence checked'} tone={warningCount > 0 ? 'warn' : 'primary'} />
        </View>
        <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} />
      </Card>
    </Pressable>
  );
}

function RecallsPreview() {
  const load = useCallback((signal: AbortSignal) => listSavedSmartRecalls({ enabled: true, signal }), []);
  const state = useMemoryResource(load);
  if (state.error) return <MemoryError error={state.error} onRetry={() => void state.refresh()} />;
  if (!state.result) return <Banner tone="info"><AppText variant="body" muted>Loading saved Recalls…</AppText></Banner>;
  return (
    <View style={{ gap: space.md }}>
      <MemoryFreshness source={state.result.source} fetchedAt={state.result.fetchedAt} />
      {state.result.data.smart_recalls.length === 0 ? (
        <Banner tone="info"><AppText variant="body" muted>No saved Recalls yet. Create one on Web when you need a reusable search.</AppText></Banner>
      ) : state.result.data.smart_recalls.slice(0, 3).map((recall) => {
        const delta = describeSmartRecallDelta(recall.last_delta);
        return (
          <MemoryRow
            key={recall.id}
            title={recall.name}
            body={recall.original_query}
            chip={<Chip label={delta.label} tone={delta.tone} />}
            onPress={() => router.push(memoryRouteForSavedRecall(recall.id) as never)}
          />
        );
      })}
    </View>
  );
}

export default function MemoryHomeScreen() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  if (!MKC_MEMORY_FEATURE_FLAGS.mobileMemorySurfaceV1) return <Redirect href="/" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <DrawerMenu />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: topPadding, paddingBottom: contentBottomPadding, gap: space.xxl }}>
        <Banner tone="info" style={{ gap: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Ionicons name="sparkles-outline" size={24} color={theme.primary} />
            <View style={{ flex: 1, gap: 4 }}>
              <AppText variant="title">Memory</AppText>
              <AppText variant="body" muted>Your evidence-backed cloud meetings, Pulse, and reusable Recalls.</AppText>
            </View>
          </View>
          <SecondaryButton label="Open Knowledge Cloud" onPress={() => void Linking.openURL(buildMkcMemoryWebUrl({ kind: 'home' }))} />
        </Banner>

        <MemorySection title="Cloud meetings" action={<AppText variant="bodyStrong" color={theme.primary} onPress={() => router.push(MKC_MEMORY_ROUTES.meetings)}>See all</AppText>}>
          {MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1 ? <MeetingsPreview /> : <Banner tone="info"><AppText variant="body" muted>Cloud Meetings remains staged off.</AppText></Banner>}
        </MemorySection>
        <MemorySection title="Pulse" action={<AppText variant="bodyStrong" color={theme.primary} onPress={() => router.push(MKC_MEMORY_ROUTES.pulse)}>Open</AppText>}>
          {MKC_MEMORY_FEATURE_FLAGS.mobileMemoryPulseV1 ? <PulsePreview /> : <Banner tone="info"><AppText variant="body" muted>Memory Pulse remains staged off.</AppText></Banner>}
        </MemorySection>
        <MemorySection title="Saved Recalls" action={<AppText variant="bodyStrong" color={theme.primary} onPress={() => router.push(MKC_MEMORY_ROUTES.savedRecalls)}>See all</AppText>}>
          {MKC_MEMORY_FEATURE_FLAGS.mobileSavedRecallsV1 ? <RecallsPreview /> : <Banner tone="info"><AppText variant="body" muted>Saved Recalls remain staged off.</AppText></Banner>}
        </MemorySection>
      </ScrollView>
    </View>
  );
}

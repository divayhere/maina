import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { AppText, Card, EmptyState, PrimaryButton } from '@/design/components';
import { type Meeting } from '@/data/meetings';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { useMeetings } from '@/state/meetingsStore';
import { formatDateTime, formatDuration } from '@/utils/format';

const STATUS_LABEL: Record<string, string> = {
  recording: 'Recording',
  interrupted: 'Recovered',
  recorded: 'Recorded',
  transcribing: 'Transcribing',
  transcribed: 'Transcript ready',
  summarizing: 'Building packet',
  summarized: 'Ready',
};

function MeetingRow({ item }: { item: Meeting }) {
  const { theme } = useAppTheme();
  return (
    <Pressable onPress={() => router.push(item.status === 'interrupted' ? `/meeting/${item.id}/recover` : `/meeting/${item.id}`)}>
      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.md }}>
          <View style={{ flex: 1, gap: 4 }}>
            <AppText variant="heading" numberOfLines={1}>{item.title}</AppText>
            <AppText variant="label" muted>
              {formatDateTime(item.startedAt)} · {formatDuration(item.durationMs)}
            </AppText>
          </View>
          <View
            style={{
              paddingHorizontal: space.md,
              paddingVertical: 6,
              borderRadius: radius.pill,
              backgroundColor: item.status === 'summarized' ? theme.done : theme.accentWash,
            }}
          >
            <AppText variant="label" color={item.status === 'summarized' ? '#fff' : theme.accent}>
              {STATUS_LABEL[item.status] ?? item.status}
            </AppText>
          </View>
        </View>

        <AppText variant="body" muted numberOfLines={2}>
          {item.summary?.trim()
            ? item.summary.trim()
            : item.status === 'summarizing'
              ? 'Maina is turning the transcript into a meeting packet…'
              : 'Transcript stays available as raw memory. Summary, decisions, and to-dos will appear here.'}
        </AppText>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <View style={{ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: theme.accentWash }}>
            <AppText variant="label" color={theme.accent}>{item.decisions.length} decisions</AppText>
          </View>
          <View style={{ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: theme.accentWash }}>
            <AppText variant="label" color={theme.accent}>{item.openTodoCount} open to-dos</AppText>
          </View>
          <View style={{ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: theme.accentWash }}>
            <AppText variant="label" color={theme.accent}>{item.openQuestions.length} questions</AppText>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

export default function MeetingsScreen() {
  const { theme } = useAppTheme();
  const { topPadding, contentBottomPadding } = useMainaLayout();
  const { meetings, refresh } = useMeetings();

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <FlatList
        data={meetings}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MeetingRow item={item} />}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        ListHeaderComponent={
          <View style={{ gap: space.lg, marginBottom: space.xl }}>
            <Card style={{ gap: space.lg, backgroundColor: theme.accent, borderColor: theme.accent }}>
              <View style={{ gap: space.sm }}>
                <AppText variant="display" color="#fff">Maina</AppText>
                <AppText variant="body" color="rgba(255,255,255,0.88)">
                  Capture meetings fast, keep transcripts local, and turn them into clean packets when you need them.
                </AppText>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                <View style={{ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.18)' }}>
                  <AppText variant="label" color="#fff">{meetings.length} meetings</AppText>
                </View>
                <View style={{ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.18)' }}>
                  <AppText variant="label" color="#fff">{meetings.filter((meeting) => meeting.status === 'summarized').length} ready packets</AppText>
                </View>
              </View>
              <PrimaryButton
                label="Start recording"
                onPress={() => router.push('/record')}
                style={{ alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.18)', shadowOpacity: 0 }}
              />
            </Card>
            <View style={{ gap: space.xs }}>
              <AppText variant="title">Recent meetings</AppText>
              <AppText variant="body" muted>
                Tap any meeting to see the summary packet. Transcript stays there as your raw memory when you need to audit or export it.
              </AppText>
            </View>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            emoji="🎙️"
            title="No meetings yet"
            subtitle="Tap record to capture your first meeting. Maina will build the packet automatically afterward."
          />
        }
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingTop: topPadding,
          paddingBottom: contentBottomPadding,
          flexGrow: 1,
        }}
      />
    </View>
  );
}

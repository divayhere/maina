import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { AppText, Card, EmptyState, RecordButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { useMeetings } from '@/state/meetingsStore';
import type { Meeting } from '@/data/meetings';
import { formatDateTime, formatDuration } from '@/utils/format';

const STATUS_LABEL: Record<string, string> = {
  recording: 'Recording',
  interrupted: 'Recovered',
  recorded: 'Recorded',
  transcribing: 'Transcribing',
  transcribed: 'Transcript',
  summarized: 'Summary',
};

export default function MeetingsScreen() {
  const { theme } = useAppTheme();
  const { meetings, refresh } = useMeetings();

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const renderItem = ({ item }: { item: Meeting }) => (
    <Pressable onPress={() => router.push(`/meeting/${item.id}`)}>
      <Card style={styles.row}>
        <View style={styles.rowText}>
          <AppText variant="heading" numberOfLines={1}>
            {item.title}
          </AppText>
          <AppText variant="label" muted>
            {formatDateTime(item.startedAt)} · {formatDuration(item.durationMs)}
          </AppText>
        </View>
        <View style={[styles.chip, { backgroundColor: theme.accentWash }]}>
          <AppText variant="label" color={theme.accent}>
            {STATUS_LABEL[item.status] ?? item.status}
          </AppText>
        </View>
        <Ionicons name="chevron-forward" color={theme.muted} size={18} />
      </Card>
    </Pressable>
  );

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <FlatList
        data={meetings}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        ListHeaderComponent={
          <View style={styles.header}>
            <AppText variant="display">Maina</AppText>
            <AppText variant="body" muted>
              {meetings.length > 0 ? 'Your meetings' : 'Tap record to start'}
            </AppText>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            emoji="🎙️"
            title="No meetings yet"
            subtitle="Tap the record button below to capture your first one."
          />
        }
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        contentContainerStyle={styles.listContent}
      />
      <View style={styles.fab} pointerEvents="box-none">
        <RecordButton recording={false} onPress={() => router.push('/record')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { paddingHorizontal: space.lg, paddingTop: space.xxl, paddingBottom: 160, flexGrow: 1 },
  header: { marginBottom: space.xl, gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  rowText: { flex: 1, gap: 2 },
  chip: { paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  fab: { position: 'absolute', bottom: space.xl, left: 0, right: 0, alignItems: 'center' },
});

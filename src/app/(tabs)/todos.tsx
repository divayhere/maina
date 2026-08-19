import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { listTodos, updateTodoDone, type TodoItem } from '@/data/meetings';
import { AppText, Card, EmptyState } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { useMeetings } from '@/state/meetingsStore';

function TodoRow({
  todo,
  meetingTitle,
  onToggle,
}: {
  todo: TodoItem;
  meetingTitle: string;
  onToggle: (value: boolean) => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable onPress={() => router.push(`/meeting/${todo.meetingId}`)}>
      <Card style={{ gap: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
          <Pressable
            onPress={() => onToggle(!todo.done)}
            hitSlop={8}
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              borderWidth: 1.5,
              borderColor: todo.done ? theme.done : theme.border,
              backgroundColor: todo.done ? theme.done : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 2,
            }}
          >
            {todo.done ? <Ionicons name="checkmark" size={16} color="#fff" /> : null}
          </Pressable>
          <View style={{ flex: 1, gap: 4 }}>
            <AppText variant="body" style={{ textDecorationLine: todo.done ? 'line-through' : 'none' }}>
              {todo.text}
            </AppText>
            <AppText variant="label" muted>
              {meetingTitle} · {todo.origin === 'manual' ? 'Manual' : 'AI extracted'}
            </AppText>
          </View>
          <Ionicons name="chevron-forward" color={theme.muted} size={18} />
        </View>
      </Card>
    </Pressable>
  );
}

export default function TodosScreen() {
  const { theme } = useAppTheme();
  const { topPadding, contentBottomPadding } = useMainaLayout();
  const { meetings, refresh } = useMeetings();
  const [todos, setTodos] = useState<TodoItem[]>([]);

  const load = useCallback(async () => {
    await refresh();
    const next = await listTodos();
    setTodos(next);
  }, [refresh]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const [openTodos, completedTodos] = useMemo(() => [
    todos.filter((todo) => !todo.done),
    todos.filter((todo) => todo.done),
  ], [todos]);

  const titleByMeetingId = useMemo(
    () => Object.fromEntries(meetings.map((meeting) => [meeting.id, meeting.title])),
    [meetings],
  );

  const renderSection = (title: string, items: TodoItem[]) => (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <AppText variant="heading">{title}</AppText>
        <View
          style={{
            paddingHorizontal: space.md,
            paddingVertical: 6,
            borderRadius: radius.pill,
            backgroundColor: theme.accentWash,
          }}
        >
          <AppText variant="label" color={theme.accent}>{items.length}</AppText>
        </View>
      </View>
      <View style={{ gap: space.md }}>
        {items.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            meetingTitle={titleByMeetingId[todo.meetingId] ?? 'Meeting'}
            onToggle={(value) => {
              void updateTodoDone(todo.id, value).then(() => load());
            }}
          />
        ))}
      </View>
    </View>
  );

  if (todos.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <View style={{ paddingHorizontal: space.lg, paddingTop: topPadding }}>
          <AppText variant="display">To-Dos</AppText>
        </View>
        <EmptyState
          emoji="✅"
          title="Your to-dos will gather here"
          subtitle="Once Maina generates meeting packets, every open next step will appear here."
        />
      </View>
    );
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{
        padding: space.lg,
        paddingTop: topPadding,
        gap: space.xl,
        paddingBottom: contentBottomPadding,
      }}
      data={[{ key: 'open' }, { key: 'done' }]}
      keyExtractor={(item) => item.key}
      ListHeaderComponent={
        <View style={{ gap: space.xs, marginBottom: space.xl }}>
          <AppText variant="display">To-Dos</AppText>
          <AppText variant="body" muted>All open next steps from your meeting memory, with direct jump-back to the source meeting.</AppText>
        </View>
      }
      renderItem={({ item }) => (
        item.key === 'open'
          ? renderSection('Open', openTodos)
          : renderSection('Completed', completedTodos)
      )}
      ItemSeparatorComponent={() => <View style={{ height: space.xl }} />}
    />
  );
}

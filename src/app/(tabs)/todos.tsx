import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { listTodos, updateTodoDone, type TodoItem } from '@/data/meetings';
import { AppText, Banner, Card, SectionLabel } from '@/design/components';
import { DrawerMenu } from '@/design/shell';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
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
      {({ pressed }) => (
        <Card style={{ gap: space.md, opacity: pressed ? 0.97 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
            <Pressable
              onPress={() => onToggle(!todo.done)}
              hitSlop={12}
              style={{
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  borderWidth: 2,
                  borderColor: todo.done ? theme.primary : theme.border,
                  backgroundColor: todo.done ? theme.primary : theme.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {todo.done ? <Ionicons name="checkmark" size={14} color="#FFFFFF" /> : null}
              </View>
            </Pressable>
            <View style={{ flex: 1, gap: 6 }}>
              <AppText
                variant="bodyStrong"
                style={{
                  color: todo.done ? theme.textSoft : theme.text,
                }}
              >
                {todo.text}
              </AppText>
              <AppText variant="meta" color={theme.primary}>
                From {meetingTitle}
              </AppText>
            </View>
          </View>
        </Card>
      )}
    </Pressable>
  );
}

export default function TodosScreen() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const { meetings, refresh } = useMeetings();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    await refresh();
    const next = await listTodos();
    setTodos(next);
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const [openTodos, doneTodos] = useMemo(
    () => [todos.filter((todo) => !todo.done), todos.filter((todo) => todo.done)],
    [todos],
  );

  const titleByMeetingId = useMemo(
    () => Object.fromEntries(meetings.map((meeting) => [meeting.id, meeting.title])),
    [meetings],
  );

  const refreshFromGesture = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <DrawerMenu />
      <FlatList
        data={['open', 'done']}
        keyExtractor={(item) => item}
        renderItem={({ item }) => {
          if (item === 'open') {
          return (
            <View style={{ gap: space.lg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <SectionLabel>To do</SectionLabel>
                  <AppText variant="meta" muted>
                    {openTodos.length} left
                  </AppText>
                </View>
                {openTodos.length > 0 ? (
                  <View style={{ gap: space.lg }}>
                    {openTodos.map((todo) => (
                      <TodoRow
                        key={todo.id}
                        todo={todo}
                        meetingTitle={titleByMeetingId[todo.meetingId] ?? 'Meeting'}
                        onToggle={(value) => {
                          void updateTodoDone(todo.id, value).then(load);
                        }}
                      />
                    ))}
                  </View>
                ) : (
                  <Banner tone="info" style={{ alignItems: 'center', gap: 8, paddingVertical: 28 }}>
                    <AppText variant="title">All done. Nothing pending.</AppText>
                  </Banner>
                )}
              </View>
            );
          }

          if (doneTodos.length === 0) return null;

          return (
            <View style={{ gap: space.lg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <SectionLabel>Done</SectionLabel>
                <AppText variant="meta" muted>
                  {doneTodos.length} done
                </AppText>
              </View>
              <View style={{ gap: space.lg }}>
                {doneTodos.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    meetingTitle={titleByMeetingId[todo.meetingId] ?? 'Meeting'}
                    onToggle={(value) => {
                      void updateTodoDone(todo.id, value).then(load);
                    }}
                  />
                ))}
              </View>
            </View>
          );
        }}
        ListHeaderComponent={
          <View style={{ gap: space.lg, paddingTop: topPadding, marginBottom: space.lg }}>
            <AppText variant="body" muted>
              Things people said they&apos;d do, picked up from your recordings.
            </AppText>
          </View>
        }
        ListEmptyComponent={
          <Banner tone="info" style={{ alignItems: 'center', gap: 8, paddingVertical: 28 }}>
            <AppText variant="title">Nothing here yet</AppText>
            <AppText variant="body" muted style={{ textAlign: 'center' }}>
              After your first recording, anything people promised to do shows up here.
            </AppText>
          </Banner>
        }
        ItemSeparatorComponent={() => <View style={{ height: space.xxxl }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshFromGesture()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: contentBottomPadding,
          paddingTop: 0,
          flexGrow: 1,
        }}
      />
    </View>
  );
}

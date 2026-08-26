import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';

import { AppText, Banner, Card } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { buildMainaNotifications } from '@/services/notifications';
import { retryNativeMeetingTranscription } from '@/services/meetingCaptureLifecycle';
import { runMeetingPacketGeneration } from '@/services/meetingPacket';
import { maybeQueueMainaKnowledgeCloudSync } from '@/services/mainaKnowledgeCloud';
import { useMeetings } from '@/state/meetingsStore';
import { formatDate, formatTime } from '@/utils/format';

export default function NotificationsScreen() {
  const { theme } = useAppTheme();
  const { topPadding, contentBottomPadding } = useMainaLayout();
  const { meetings, refresh } = useMeetings();
  const [runningActionId, setRunningActionId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const notifications = buildMainaNotifications(meetings);

  const runAction = async (item: typeof notifications[number]) => {
    if (item.action === 'review_recovery' || item.action === 'review_meeting' || item.action === 'open_settings') {
      router.push(item.href as never);
      return;
    }
    setRunningActionId(item.id);
    try {
      if (item.action === 'retry_transcript') {
        const started = await retryNativeMeetingTranscription(item.meetingId);
        if (!started) router.push(item.href as never);
      } else if (item.action === 'retry_notes') {
        await runMeetingPacketGeneration(item.meetingId);
      } else if (item.action === 'retry_cloud') {
        await maybeQueueMainaKnowledgeCloudSync(item.meetingId, { includeAuthFailures: true });
      }
      await refresh();
    } finally {
      setRunningActionId(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title="Notifications" back />
      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push(item.href as never)}>
            {({ pressed }) => (
              <Card style={{ gap: space.md, opacity: pressed ? 0.97 : 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: item.tone === 'warn' ? theme.warnSoft : theme.mint,
                    }}
                  >
                    <Ionicons
                      name={item.tone === 'warn' ? 'alert-circle-outline' : 'checkmark-done-outline'}
                      size={20}
                      color={item.tone === 'warn' ? theme.warn : theme.primary}
                    />
                  </View>
                  <View style={{ flex: 1, gap: 6 }}>
                    <AppText variant="bodyStrong">{item.title}</AppText>
                    <AppText variant="body" muted>{item.body}</AppText>
                    <AppText variant="meta" muted>
                      {formatDate(item.createdAt)} · {formatTime(item.createdAt)}
                    </AppText>
                    <Pressable
                      onPress={() => void runAction(item)}
                      disabled={runningActionId === item.id}
                      hitSlop={8}
                      style={{ alignSelf: 'flex-start', paddingVertical: 4 }}
                    >
                      {runningActionId === item.id ? (
                        <ActivityIndicator size="small" color={theme.primary} />
                      ) : (
                        <AppText variant="bodyStrong" color={theme.primary}>{item.actionLabel}</AppText>
                      )}
                    </Pressable>
                  </View>
                </View>
              </Card>
            )}
          </Pressable>
        )}
        ItemSeparatorComponent={() => <View style={{ height: space.lg }} />}
        ListHeaderComponent={<View style={{ height: topPadding }} />}
        ListEmptyComponent={
          <Banner tone="info" style={{ alignItems: 'center', gap: 8, paddingVertical: 28 }}>
            <AppText variant="title">All clear</AppText>
            <AppText variant="body" muted style={{ textAlign: 'center' }}>
              Nothing needs your attention.
            </AppText>
          </Banner>
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: contentBottomPadding,
          flexGrow: 1,
        }}
      />
    </View>
  );
}

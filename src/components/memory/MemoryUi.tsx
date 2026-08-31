import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { AppText, Banner, Card, Chip, SecondaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import type { MkcMemoryReadError } from '@/services/mkc-memory-client';
import { describeMemoryFreshness, memoryErrorAction } from '@/services/mkc-memory-presentation';

export function MemoryFreshness({ source, fetchedAt }: { source: 'network' | 'cache'; fetchedAt: number }) {
  const freshness = describeMemoryFreshness({ source, fetchedAt });
  return <Chip label={freshness.label} tone={freshness.stale ? 'warn' : 'primary'} />;
}

export function MemoryError({ error, onRetry }: { error: MkcMemoryReadError; onRetry: () => void }) {
  const action = memoryErrorAction(error);
  return (
    <Banner tone={error.kind === 'offline' ? 'info' : 'warn'} style={{ gap: space.md }}>
      <AppText variant="bodyStrong">Memory is not available yet</AppText>
      <AppText variant="body" muted>{error.message}</AppText>
      <SecondaryButton
        label={action.label}
        onPress={() => action.destination ? router.push(action.destination) : onRetry()}
      />
    </Banner>
  );
}

export function MemoryRow({
  title,
  body,
  meta,
  chip,
  onPress,
}: {
  title: string;
  body?: string | null;
  meta?: string | null;
  chip?: ReactNode;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <Card style={{ gap: space.sm, opacity: pressed ? 0.96 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
            <View style={{ flex: 1, gap: 6 }}>
              <AppText variant="bodyStrong">{title}</AppText>
              {body ? <AppText variant="body" muted numberOfLines={3}>{body}</AppText> : null}
              {meta ? <AppText variant="meta" muted>{meta}</AppText> : null}
            </View>
            {chip}
            <Ionicons name="chevron-forward" size={18} color={theme.textSoft} />
          </View>
        </Card>
      )}
    </Pressable>
  );
}

export function MemorySection({ title, action, children }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
        <AppText variant="heading">{title}</AppText>
        {action}
      </View>
      {children}
    </View>
  );
}

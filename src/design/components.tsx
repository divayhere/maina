/**
 * Shared UI kit, themed from tokens. Apple-calm bones + Gen-Z spark.
 * Everything visual routes through here so a restyle stays in one place.
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  type TextProps,
  View,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, space, type as typeScale } from './tokens';
import { useAppTheme } from './theme';

type TextVariant = 'display' | 'title' | 'heading' | 'body' | 'label' | 'mono';

export function AppText({
  variant = 'body',
  color,
  muted,
  style,
  ...rest
}: TextProps & { variant?: TextVariant; color?: string; muted?: boolean }) {
  const { theme } = useAppTheme();
  const base = typeScale[variant];
  const resolved = color ?? (muted ? theme.muted : theme.text);
  return <Text {...rest} style={[base, { color: resolved }, style]} />;
}

export function Screen({ children, style, ...rest }: ViewProps) {
  const { theme } = useAppTheme();
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]} edges={['top']}>
      <View style={[styles.screenInner, style]} {...rest}>
        {children}
      </View>
    </SafeAreaView>
  );
}

export function Card({ children, style, ...rest }: ViewProps) {
  const { theme } = useAppTheme();
  return (
    <View
      {...rest}
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
        style,
      ]}>
      {children}
    </View>
  );
}

export function PrimaryButton({
  label,
  loading,
  style,
  ...rest
}: PressableProps & { label: string; loading?: boolean }) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      {...rest}
      style={(state) => [
        styles.primaryBtn,
        { backgroundColor: theme.accent, opacity: state.pressed ? 0.85 : 1 },
        typeof style === 'function' ? style(state) : style,
      ]}>
      {loading ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={[typeScale.heading, styles.primaryBtnText]}>{label}</Text>
      )}
    </Pressable>
  );
}

/** The big record / stop control. Circular, alive, unmistakable. */
export function RecordButton({
  recording,
  onPress,
}: {
  recording: boolean;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
      onPress={onPress}
      style={({ pressed }) => [
        styles.recOuter,
        { borderColor: recording ? theme.rec : theme.accent, opacity: pressed ? 0.9 : 1 },
      ]}>
      <View
        style={[
          recording ? styles.recInnerStop : styles.recInnerStart,
          { backgroundColor: recording ? theme.rec : theme.accent },
        ]}
      />
    </Pressable>
  );
}

export function EmptyState({
  title,
  subtitle,
  emoji,
}: {
  title: string;
  subtitle?: string;
  emoji?: string;
}) {
  return (
    <View style={styles.empty}>
      {emoji ? <Text style={styles.emptyEmoji}>{emoji}</Text> : null}
      <AppText variant="heading" style={styles.emptyText}>
        {title}
      </AppText>
      {subtitle ? (
        <AppText variant="body" muted style={styles.emptyText}>
          {subtitle}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenInner: { flex: 1, paddingHorizontal: space.lg },
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  primaryBtn: {
    minHeight: 54,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    flexDirection: 'row',
  },
  primaryBtnText: { color: '#fff' },
  recOuter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recInnerStart: { width: 60, height: 60, borderRadius: 30 },
  recInnerStop: { width: 30, height: 30, borderRadius: 7 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.xl },
  emptyEmoji: { fontSize: 40, marginBottom: space.sm },
  emptyText: { textAlign: 'center' },
});

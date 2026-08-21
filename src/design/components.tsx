import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  type TextStyle,
  type TextProps,
  View,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { radius, space, type as typeScale } from './tokens';
import { useAppTheme } from './theme';

type TextVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'meta'
  | 'chip'
  | 'tab'
  | 'mono'
  | 'timer';

export function AppText({
  variant = 'body',
  color,
  muted,
  style,
  ...rest
}: TextProps & { variant?: TextVariant; color?: string; muted?: boolean }) {
  const { theme } = useAppTheme();
  const base = typeScale[variant] as unknown as TextStyle;
  const resolvedColor = color ?? (muted ? theme.textSoft : theme.text);
  return <Text {...rest} style={[base, { color: resolvedColor }, style]} />;
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
        {
          backgroundColor: theme.surface,
          borderColor: theme.border,
          shadowColor: '#142221',
        },
        style,
      ]}>
      {children}
    </View>
  );
}

export function Banner({
  tone = 'info',
  children,
  style,
  ...rest
}: ViewProps & { tone?: 'info' | 'warn' | 'live' }) {
  const { theme } = useAppTheme();
  const backgroundColor =
    tone === 'warn' ? theme.warnSoft : tone === 'live' ? theme.liveSoft : theme.mint;
  return (
    <View
      {...rest}
      style={[
        styles.banner,
        {
          backgroundColor,
          borderColor: tone === 'warn' ? theme.warnSoft : backgroundColor,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

export function Chip({
  label,
  tone = 'muted',
  style,
}: {
  label: string;
  tone?: 'muted' | 'primary' | 'warn' | 'live';
  style?: ViewProps['style'];
}) {
  const { theme } = useAppTheme();
  const colors = {
    muted: { bg: theme.mutedSoft, fg: theme.textSoft },
    primary: { bg: theme.accent, fg: theme.accentText },
    warn: { bg: theme.warnSoft, fg: theme.warn },
    live: { bg: theme.liveSoft, fg: theme.live },
  }[tone];

  return (
    <View style={[styles.chip, { backgroundColor: colors.bg }, style]}>
      <AppText variant="chip" color={colors.fg}>
        {label}
      </AppText>
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
  const isDisabled = !!rest.disabled;
  return (
    <Pressable
      {...rest}
      style={(state) => [
        styles.primaryBtn,
        {
          backgroundColor: theme.primary,
          shadowColor: theme.primary,
          opacity: isDisabled ? 0.5 : 1,
          transform: [{ scale: state.pressed ? 0.985 : 1 }],
        },
        typeof style === 'function' ? style(state) : style,
      ]}>
      {loading ? (
        <ActivityIndicator color={theme.primaryForeground} />
      ) : (
        <AppText variant="heading" color={theme.primaryForeground}>
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  style,
  ...rest
}: PressableProps & { label: string }) {
  const { theme } = useAppTheme();
  const isDisabled = !!rest.disabled;
  return (
    <Pressable
      {...rest}
      style={(state) => [
        styles.secondaryBtn,
        {
          backgroundColor: theme.mutedSoft,
          borderColor: theme.mutedSoft,
          opacity: isDisabled ? 0.5 : 1,
          transform: [{ scale: state.pressed ? 0.985 : 1 }],
        },
        typeof style === 'function' ? style(state) : style,
      ]}>
      <AppText variant="heading">{label}</AppText>
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
      <AppText variant="title" style={styles.emptyText}>
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

export function SectionLabel({ children }: { children: React.ReactNode }) {
  const { theme } = useAppTheme();
  return (
    <AppText
      variant="label"
      color={theme.textSoft}
      style={{ textTransform: 'uppercase', letterSpacing: 1 }}
    >
      {children}
    </AppText>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenInner: { flex: 1, paddingHorizontal: 16 },
  card: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 16,
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 1,
  },
  banner: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 16,
  },
  chip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  primaryBtn: {
    minHeight: 56,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  secondaryBtn: {
    minHeight: 56,
    borderWidth: 1,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: 24,
  },
  emptyEmoji: {
    fontSize: 40,
    marginBottom: space.sm,
  },
  emptyText: {
    textAlign: 'center',
  },
});

/**
 * Maina design tokens.
 * Source: Lovable handoff v2, translated for Expo React Native.
 */

export const palette = {
  background: '#FFFFFF',
  foreground: '#142221',
  card: '#FFFFFF',
  primary: '#098777',
  primaryForeground: '#FFFFFF',
  muted: '#EFFAF7',
  mutedForeground: '#5F7070',
  accent: '#C8F2E9',
  accentForeground: '#075449',
  mint: '#DCF7F1',
  live: '#E2484F',
  liveSoft: 'rgba(226,72,79,0.1)',
  warn: '#BE7125',
  warnSoft: '#FFEFD5',
  destructive: '#DE3A46',
  border: '#DAE3E3',
  input: '#D6E1E0',
  ring: '#098777',
  overlay: 'rgba(20,34,33,0.25)',
  overlayStrong: 'rgba(20,34,33,0.3)',
} as const;

export interface Theme {
  bg: string;
  surface: string;
  text: string;
  textSoft: string;
  muted: string;
  mutedSoft: string;
  border: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  accentWash: string;
  mint: string;
  live: string;
  liveSoft: string;
  warn: string;
  warnSoft: string;
  destructive: string;
  rec: string;
  done: string;
  ring: string;
  overlay: string;
  overlayStrong: string;
}

export const lightTheme: Theme = {
  bg: palette.background,
  surface: palette.card,
  text: palette.foreground,
  textSoft: palette.mutedForeground,
  muted: palette.mutedForeground,
  mutedSoft: palette.muted,
  border: palette.border,
  primary: palette.primary,
  primaryForeground: palette.primaryForeground,
  accent: palette.accent,
  accentText: palette.accentForeground,
  accentSoft: palette.accent,
  accentWash: palette.muted,
  mint: palette.mint,
  live: palette.live,
  liveSoft: palette.liveSoft,
  warn: palette.warn,
  warnSoft: palette.warnSoft,
  destructive: palette.destructive,
  rec: palette.live,
  done: palette.primary,
  ring: palette.ring,
  overlay: palette.overlay,
  overlayStrong: palette.overlayStrong,
};

export const darkTheme = lightTheme;

export const fontFamily = {
  regular: 'PlusJakartaSans-Regular',
  medium: 'PlusJakartaSans-Medium',
  semibold: 'PlusJakartaSans-SemiBold',
  bold: 'PlusJakartaSans-Bold',
  extrabold: 'PlusJakartaSans-ExtraBold',
  mono: 'monospace',
} as const;

export const space = {
  xs: 4,
  s: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 28,
  huge: 32,
  giant: 40,
} as const;

export const radius = {
  md: 16,
  lg: 20,
  xl: 24,
  pill: 999,
} as const;

export const type = {
  display: {
    fontSize: 32,
    lineHeight: 38,
    fontFamily: fontFamily.bold,
    letterSpacing: -0.48,
  },
  title: {
    fontSize: 22,
    lineHeight: 28,
    fontFamily: fontFamily.bold,
    letterSpacing: -0.33,
  },
  heading: {
    fontSize: 17,
    lineHeight: 22,
    fontFamily: fontFamily.bold,
    letterSpacing: -0.2,
  },
  body: {
    fontSize: 16,
    lineHeight: 25,
    fontFamily: fontFamily.regular,
  },
  bodyStrong: {
    fontSize: 15,
    lineHeight: 20,
    fontFamily: fontFamily.semibold,
  },
  label: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: fontFamily.semibold,
    letterSpacing: 0.65,
  },
  meta: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fontFamily.regular,
  },
  chip: {
    fontSize: 11,
    lineHeight: 14,
    fontFamily: fontFamily.bold,
  },
  tab: {
    fontSize: 11,
    lineHeight: 14,
    fontFamily: fontFamily.semibold,
  },
  mono: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: fontFamily.mono,
  },
  timer: {
    fontSize: 48,
    lineHeight: 48,
    fontFamily: fontFamily.extrabold,
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
} as const;

export const motion = {
  fast: 180,
  base: 260,
  slow: 400,
} as const;

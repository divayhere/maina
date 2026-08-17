/**
 * Design tokens — the single source of truth for Maina's look.
 * SWAP-SEAM: restyle the whole app by editing this file only.
 * Direction: Apple-calm bones + Gen-Z spark. Palette: "Electric Grape".
 */

export const palette = {
  // Signature
  grape: '#6C4CE0',
  grapeDeep: '#5334C9',
  lilac: '#B7A6F5',
  lilacWash: '#EAE4FB',

  // Neutrals (slight violet bias, chosen not defaulted)
  nearWhite: '#F2F1F8',
  white: '#FFFFFF',
  ink: '#1C1830',
  inkSoft: '#443C63',
  muted: '#6E6890',
  border: '#E2DEF0',

  // Dark ground
  nightBg: '#121020',
  nightSurface: '#1B1830',
  nightBorder: '#2C2846',

  // Semantic (separate from the accent)
  rec: '#E5484D',      // recording
  done: '#2FA36B',     // completed
  warn: '#C98A24',     // caution
} as const;

export interface Theme {
  bg: string; surface: string; text: string; textSoft: string;
  muted: string; border: string; accent: string; accentSoft: string;
  accentWash: string; rec: string; done: string; warn: string;
}

export const lightTheme: Theme = {
  bg: palette.nearWhite,
  surface: palette.white,
  text: palette.ink,
  textSoft: palette.inkSoft,
  muted: palette.muted,
  border: palette.border,
  accent: palette.grape,
  accentSoft: palette.lilac,
  accentWash: palette.lilacWash,
  rec: palette.rec,
  done: palette.done,
  warn: palette.warn,
};

export const darkTheme: Theme = {
  bg: palette.nightBg,
  surface: palette.nightSurface,
  text: '#EFECFA',
  textSoft: '#C7C1E6',
  muted: '#948DBA',
  border: palette.nightBorder,
  accent: '#9B84F0',
  accentSoft: '#6C4CE0',
  accentWash: '#241F3D',
  rec: '#F2685F',
  done: '#57B37D',
  warn: '#D69648',
};

/** 4px base spacing scale. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

/** Rounded, friendly geometry. */
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

/** Type scale. Body = system for crispness; display swaps in a bundled expressive face later. */
export const type = {
  display: { fontSize: 34, lineHeight: 38, fontWeight: '700' as const, letterSpacing: -0.5 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const, letterSpacing: 0.3 },
  mono: { fontSize: 13, lineHeight: 18, fontFamily: 'ui-monospace' },
} as const;

export const motion = {
  spring: { damping: 18, stiffness: 220, mass: 0.9 },
  fast: 160,
  base: 240,
} as const;

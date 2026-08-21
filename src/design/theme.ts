import { darkTheme, lightTheme, type Theme } from './tokens';

/** Maina v2 is intentionally light-only for now. */
export function useAppTheme(): { theme: Theme; scheme: 'light' | 'dark' } {
  void darkTheme;
  return { theme: lightTheme, scheme: 'light' };
}

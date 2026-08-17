import { useColorScheme } from 'react-native';
import { darkTheme, lightTheme, type Theme } from './tokens';

/** Resolves the active theme from the OS colour scheme. */
export function useAppTheme(): { theme: Theme; scheme: 'light' | 'dark' } {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { theme: scheme === 'dark' ? darkTheme : lightTheme, scheme };
}

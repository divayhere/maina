import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { space } from './tokens';

export const TAB_BAR_BASE_HEIGHT = 78;

export function useMainaLayout() {
  const insets = useSafeAreaInsets();

  return {
    insets,
    topPadding: insets.top + space.xl,
    tabBarHeight: TAB_BAR_BASE_HEIGHT + insets.bottom,
    contentBottomPadding: TAB_BAR_BASE_HEIGHT + insets.bottom + space.xl,
    floatingBottomOffset: TAB_BAR_BASE_HEIGHT + insets.bottom + space.md,
  };
}

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { space } from './tokens';

export const TAB_BAR_BASE_HEIGHT = 88;
export const TOP_BAR_HEIGHT = 56;
export const RECORD_BAR_BUTTON_SIZE = 72;

export function useMainaLayout() {
  const insets = useSafeAreaInsets();
  const tabBarHeight = TAB_BAR_BASE_HEIGHT + insets.bottom;
  const topBarHeight = TOP_BAR_HEIGHT + insets.top;

  return {
    insets,
    topBarHeight,
    topPadding: space.lg,
    tabBarHeight,
    contentBottomPadding: tabBarHeight + space.md,
    recordBarOverlap: 10,
  };
}

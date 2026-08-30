export type NavigationActions = {
  dismissTo(href: '/'): void;
  push(href: `/meeting/${string}`): void;
};

export function openNewlySavedMeetingRoute(
  navigation: NavigationActions,
  meetingId: string,
  schedule: (work: () => void) => void,
): void {
  navigation.dismissTo('/');
  schedule(() => navigation.push(`/meeting/${meetingId}`));
}

export function backOrHome(input: {
  canGoBack: boolean;
  back(): void;
  home(): void;
}): void {
  if (input.canGoBack) input.back();
  else input.home();
}


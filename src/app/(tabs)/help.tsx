import { ScrollView, View } from 'react-native';

import { AppText, Banner, Card, SectionLabel } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { TopBar } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';

const FAQ = [
  {
    q: 'How does Maina work?',
    a: 'You record on this phone, Maina turns the speech into a transcript locally, then writes notes later using your connected AI account.',
  },
  {
    q: 'Does Maina keep my audio forever?',
    a: 'No. Audio is temporary recovery material. Transcript and notes stay; audio is removed after the retention window.',
  },
  {
    q: 'Why do I need an AI account?',
    a: 'Transcript creation is local. Summary, decisions, and to-dos are written using the AI key you connect in Settings.',
  },
  {
    q: 'Why did my clicker stop working?',
    a: 'Android can disable accessibility-based controls after restarts or battery cleanup. Re-open Maina and check clicker status in Settings.',
  },
];

export default function HelpScreen() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title="Help" back />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: topPadding,
          paddingBottom: contentBottomPadding,
          gap: space.xl,
        }}
      >
        <Banner tone="info" style={{ gap: 8 }}>
          <AppText variant="title">Maina help</AppText>
          <AppText variant="body" muted>
            The essentials for recording, recovery, notes, and the clicker setup flow.
          </AppText>
        </Banner>

        <View style={{ gap: space.lg }}>
          <SectionLabel>Common questions</SectionLabel>
          {FAQ.map((item) => (
            <Card key={item.q} style={{ gap: 8 }}>
              <AppText variant="heading">{item.q}</AppText>
              <AppText variant="body" muted>{item.a}</AppText>
            </Card>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

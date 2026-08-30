import { Redirect } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { AppText, Banner, Card } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { DrawerMenu } from '@/design/shell';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';

export default function MemoryHomeScreen() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();

  if (!MKC_MEMORY_FEATURE_FLAGS.mobileMemorySurfaceV1) return <Redirect href="/" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <DrawerMenu />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: topPadding,
          paddingBottom: contentBottomPadding,
          gap: space.lg,
        }}
      >
        <Banner tone="info" style={{ gap: space.sm }}>
          <AppText variant="title">Memory</AppText>
          <AppText variant="body" muted>
            Your cloud meetings, Pulse, and saved Recalls will live here.
          </AppText>
        </Banner>
        <Card style={{ gap: space.sm }}>
          <AppText variant="heading">Maina Cloud</AppText>
          <AppText variant="body" muted>
            This surface is staged safely while its versioned cloud contracts complete qualification.
          </AppText>
        </Card>
      </ScrollView>
    </View>
  );
}

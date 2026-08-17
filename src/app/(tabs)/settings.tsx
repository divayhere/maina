import Constants from 'expo-constants';
import { ScrollView, View } from 'react-native';

import { AppText, Card } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { DEFAULT_CONFIG } from '@/services/config';
import { getProvider } from '@/core/summarization/providers';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm, gap: space.md }}>
      <AppText variant="body" muted>{label}</AppText>
      <AppText variant="body" style={{ flexShrink: 1, textAlign: 'right' }}>{value}</AppText>
    </View>
  );
}

export default function SettingsScreen() {
  const { theme } = useAppTheme();
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const provider = getProvider(DEFAULT_CONFIG.providerId);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl, gap: space.lg }}>
      <AppText variant="display">Settings</AppText>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>AI PROVIDER (SUMMARIES)</AppText>
        <Row label="Provider" value={provider?.label ?? '—'} />
        <Row label="Auto-summarize" value={DEFAULT_CONFIG.autoSummarize ? 'On' : 'Off'} />
        <AppText variant="label" muted style={{ marginTop: space.sm }}>
          Full provider setup and API keys arrive in Phase 3.
        </AppText>
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>TRANSCRIPTION</AppText>
        <Row label="Model" value={DEFAULT_CONFIG.transcriptionModel} />
        <Row label="Language" value={DEFAULT_CONFIG.transcriptionLanguage} />
        <Row label="Delete audio after transcript" value={DEFAULT_CONFIG.audioAutoDelete ? 'On' : 'Off'} />
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>ABOUT</AppText>
        <Row label="Version" value={version} />
        <Row label="Phase" value="1 — recording" />
      </Card>
    </ScrollView>
  );
}

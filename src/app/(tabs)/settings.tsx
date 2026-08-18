import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { getProvider } from '@/core/summarization/providers';
import {
  ACTIVE_LANGUAGES,
  provisionCoreLanguages,
  LANGUAGES,
  supportsOnDevice,
  type LanguageProvisioningState,
} from '@/core/transcription/nativeSpeech';
import { AppText, Card } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { DEFAULT_CONFIG } from '@/services/config';

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

  const [onDevice, setOnDevice] = useState<boolean | null>(null);
  const [languages, setLanguages] = useState<LanguageProvisioningState | null>(null);

  const load = useCallback(async () => {
    setOnDevice(supportsOnDevice());
    setLanguages(await provisionCoreLanguages());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl, gap: space.lg }}>
      <AppText variant="display">Settings</AppText>

      <Card style={{ gap: space.sm }}>
        <AppText variant="label" muted>OFFLINE SPEECH</AppText>
        <AppText variant="label" muted style={{ marginBottom: space.xs }}>
          Maina automatically provisions Indian English and Hindi, then switches between them for Hinglish.
        </AppText>
        {LANGUAGES.map((language) => {
          const installed = languages?.installed.some((item) => item.toLowerCase() === language.code.toLowerCase());
          return <Row key={language.code} label={language.label} value={installed ? 'Ready' : 'Installing…'} />;
        })}
        <Row label="Active switch set" value={ACTIVE_LANGUAGES.join(' + ')} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs }}>
          <Ionicons
            name={onDevice ? 'phone-portrait-outline' : 'cloud-outline'}
            size={16}
            color={onDevice ? theme.done : theme.warn}
          />
          <AppText variant="label" muted>
            {onDevice === null
              ? 'Checking on-device support…'
              : onDevice
                ? languages?.ready
                  ? 'On-device bilingual recognition ready'
                  : 'On-device supported · language setup continues automatically'
                : 'On-device unavailable — recording is blocked to protect privacy'}
          </AppText>
        </View>
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>AI PROVIDER (SUMMARIES)</AppText>
        <Row label="Provider" value={provider?.label ?? '—'} />
        <Row label="Auto-summarize" value={DEFAULT_CONFIG.autoSummarize ? 'On' : 'Off'} />
        <AppText variant="label" muted style={{ marginTop: space.sm }}>
          Not active in this build. No transcript is sent to an AI provider automatically.
        </AppText>
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>DEVELOPMENT BACKUP</AppText>
        <Row label="Source WAV cleanup" value={DEFAULT_CONFIG.keepAudioAfterTranscript ? 'Manual' : 'After verified upload'} />
        <AppText variant="label" muted>
          Maina keeps every WAV until its compressed backup and transcript are safely uploaded. Remote artifacts expire after seven days.
        </AppText>
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>ABOUT</AppText>
        <Row label="Version" value={version} />
        <Row label="Engine" value="Android on-device speech + durable WAV" />
        <Row label="Audio files" value="10-minute checkpoints" />
      </Card>

      <Pressable onPress={() => router.push('/diagnostics')}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Ionicons name="pulse-outline" size={20} color={theme.accent} />
            <AppText variant="body">System status</AppText>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.muted} />
        </Card>
      </Pressable>
    </ScrollView>
  );
}

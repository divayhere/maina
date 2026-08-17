import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { isModelDownloaded } from '@/core/transcription';
import { MODEL_ORDER, WHISPER_MODELS } from '@/core/transcription/models';
import { getSelectedModel, setSelectedModel } from '@/data/settings';
import { AppText, Card } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
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

  const [selected, setSelected] = useState('');
  const [downloaded, setDownloaded] = useState<Record<string, boolean>>({});

  const loadModelState = useCallback(async () => {
    setSelected(await getSelectedModel());
    const map: Record<string, boolean> = {};
    for (const id of MODEL_ORDER) map[id] = await isModelDownloaded(id);
    setDownloaded(map);
  }, []);

  useEffect(() => {
    loadModelState();
  }, [loadModelState]);

  const pick = async (id: string) => {
    setSelected(id);
    await setSelectedModel(id);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl, gap: space.lg }}>
      <AppText variant="display">Settings</AppText>

      <Card style={{ gap: space.sm }}>
        <AppText variant="label" muted>TRANSCRIPTION MODEL</AppText>
        <AppText variant="label" muted style={{ marginBottom: space.xs }}>
          Bigger = better Hindi, slower, larger download. Downloads on first use.
        </AppText>
        {MODEL_ORDER.map((id) => {
          const m = WHISPER_MODELS[id];
          const isSel = selected === id;
          return (
            <Pressable
              key={id}
              onPress={() => pick(id)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                paddingVertical: space.sm,
                paddingHorizontal: space.md,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: isSel ? theme.accent : theme.border,
                backgroundColor: isSel ? theme.accentWash : 'transparent',
              }}>
              <Ionicons
                name={isSel ? 'radio-button-on' : 'radio-button-off'}
                size={20}
                color={isSel ? theme.accent : theme.muted}
              />
              <View style={{ flex: 1 }}>
                <AppText variant="body">{m.label}</AppText>
                <AppText variant="label" muted>{m.hint}</AppText>
              </View>
              {downloaded[id] ? (
                <Ionicons name="checkmark-circle" size={18} color={theme.done} />
              ) : (
                <AppText variant="label" muted>download</AppText>
              )}
            </Pressable>
          );
        })}
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>AI PROVIDER (SUMMARIES)</AppText>
        <Row label="Provider" value={provider?.label ?? '—'} />
        <Row label="Auto-summarize" value={DEFAULT_CONFIG.autoSummarize ? 'On' : 'Off'} />
        <AppText variant="label" muted style={{ marginTop: space.sm }}>
          Full provider setup and API keys arrive in Phase 3.
        </AppText>
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>PRIVACY</AppText>
        <Row label="Language" value={DEFAULT_CONFIG.transcriptionLanguage} />
        <Row label="Delete audio after transcript" value={DEFAULT_CONFIG.audioAutoDelete ? 'On' : 'Off'} />
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>ABOUT</AppText>
        <Row label="Version" value={version} />
        <Row label="Phase" value="2 — on-device transcription" />
      </Card>

      <Pressable onPress={() => router.push('/diagnostics')}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Ionicons name="pulse-outline" size={20} color={theme.accent} />
            <AppText variant="body">Diagnostics &amp; logs</AppText>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.muted} />
        </Card>
      </Pressable>
    </ScrollView>
  );
}

import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from 'react-native';

import { getProvider } from '@/core/summarization/providers';
import {
  downloadOfflineLanguage,
  getOfflineLocales,
  LANGUAGES,
  supportsOnDevice,
} from '@/core/transcription/nativeSpeech';
import { getLanguage, setLanguage } from '@/data/settings';
import { AppText, Card } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { DEFAULT_CONFIG } from '@/services/config';
import { log } from '@/services/logger';

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

  const [lang, setLang] = useState('');
  const [installed, setInstalled] = useState<string[]>([]);
  const [onDevice, setOnDevice] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLang(await getLanguage());
    setOnDevice(supportsOnDevice());
    const { installed: inst } = await getOfflineLocales();
    setInstalled(inst);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pick = async (code: string) => {
    setLang(code);
    await setLanguage(code);
  };

  const download = async (code: string) => {
    setDownloading(code);
    try {
      const status = await downloadOfflineLanguage(code);
      Alert.alert(
        'Offline language',
        status === 'download_success'
          ? 'Downloaded — offline recognition ready.'
          : status === 'opened_dialog'
            ? 'Android opened its download dialog. Accept it to finish.'
            : 'Download scheduled (may wait for Wi-Fi).',
      );
    } catch (e) {
      log.error('settings', 'offline download failed', { err: String(e) });
      Alert.alert('Offline language', 'Could not start the download on this device.');
    } finally {
      setDownloading(null);
      load();
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl, gap: space.lg }}>
      <AppText variant="display">Settings</AppText>

      <Card style={{ gap: space.sm }}>
        <AppText variant="label" muted>SPEECH LANGUAGE</AppText>
        <AppText variant="label" muted style={{ marginBottom: space.xs }}>
          Transcribes live on your phone. Hindi handles Hinglish (mixed) best.
        </AppText>
        {LANGUAGES.map((l) => {
          const sel = lang === l.code;
          const have = installed.includes(l.code);
          return (
            <View key={l.code} style={{ gap: space.xs }}>
              <Pressable
                onPress={() => pick(l.code)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  paddingVertical: space.sm,
                  paddingHorizontal: space.md,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: sel ? theme.accent : theme.border,
                  backgroundColor: sel ? theme.accentWash : 'transparent',
                }}>
                <Ionicons
                  name={sel ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={sel ? theme.accent : theme.muted}
                />
                <View style={{ flex: 1 }}>
                  <AppText variant="body">{l.label}</AppText>
                  {l.hint ? <AppText variant="label" muted>{l.hint}</AppText> : null}
                </View>
                {have ? (
                  <Ionicons name="cloud-done-outline" size={18} color={theme.done} />
                ) : downloading === l.code ? (
                  <ActivityIndicator color={theme.accent} />
                ) : (
                  <Pressable onPress={() => download(l.code)} hitSlop={8}>
                    <AppText variant="label" color={theme.accent}>get offline</AppText>
                  </Pressable>
                )}
              </Pressable>
            </View>
          );
        })}
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
                ? 'On-device recognition supported'
                : 'On-device not available — will use Google servers'}
          </AppText>
        </View>
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
        <Row label="Delete audio after transcript" value={DEFAULT_CONFIG.audioAutoDelete ? 'On' : 'Off'} />
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>ABOUT</AppText>
        <Row label="Version" value={version} />
        <Row label="Engine" value="Phone speech engine (live)" />
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

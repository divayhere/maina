import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
} from 'react-native';

import { getProvider, PROVIDERS, type AIProvider } from '@/core/summarization/providers';
import {
  ACTIVE_LANGUAGES,
  provisionCoreLanguages,
  LANGUAGES,
  supportsOnDevice,
  type LanguageProvisioningState,
} from '@/core/transcription/nativeSpeech';
import { AppText, Card, PrimaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { getRemoteControlStatus, openRemoteAccessibilitySettings } from '@/hardware/recording/foreground';
import { describeRemoteHealth, formatRemoteLastPress } from '@/hardware/trigger/remoteHealth';
import type { RemoteControlStatus } from '../../../modules/maina-recorder/src';
import { DEFAULT_CONFIG, getAppConfig, getProviderSettings, saveAppConfig, saveProviderSettings, type AppConfig, type ProviderSettings } from '@/services/config';
import { log } from '@/services/logger';
import { queueEligibleMeetingPackets } from '@/services/meetingPacket';
import { validateProviderSettings } from '@/services/providerValidation';

function Row({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
        <AppText variant="body" muted>{label}</AppText>
        <AppText variant="body" style={{ flexShrink: 1, textAlign: 'right' }}>{value}</AppText>
      </View>
      {helper ? <AppText variant="label" muted>{helper}</AppText> : null}
    </View>
  );
}

function ProviderChip({
  provider,
  selected,
  onPress,
}: {
  provider: AIProvider;
  selected: boolean;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: selected ? theme.accent : theme.border,
        backgroundColor: selected ? theme.accentWash : theme.surface,
      }}
    >
      <AppText variant="label" color={selected ? theme.accent : theme.text}>
        {provider.label}
      </AppText>
    </Pressable>
  );
}

function Input({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  multiline?: boolean;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={{ gap: space.sm }}>
      <AppText variant="label" muted>{label}</AppText>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: radius.lg,
          backgroundColor: theme.surface,
          color: theme.text,
          paddingHorizontal: space.lg,
          paddingVertical: multiline ? space.lg : space.md,
          minHeight: multiline ? 92 : 52,
        }}
      />
    </View>
  );
}

export default function SettingsScreen() {
  const { theme } = useAppTheme();
  const { topPadding, contentBottomPadding } = useMainaLayout();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [providerSettings, setProviderState] = useState<ProviderSettings>({
    providerId: DEFAULT_CONFIG.providerId,
    apiKey: '',
    model: getProvider(DEFAULT_CONFIG.providerId)?.defaultModel ?? '',
    customBaseUrl: '',
  });
  const [onDevice, setOnDevice] = useState<boolean | null>(null);
  const [languages, setLanguages] = useState<LanguageProvisioningState | null>(null);
  const [remote, setRemote] = useState<RemoteControlStatus | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const selectedProvider = useMemo(
    () => getProvider(config.providerId) ?? getProvider(DEFAULT_CONFIG.providerId)!,
    [config.providerId],
  );
  const remoteHealth = useMemo(() => describeRemoteHealth(remote), [remote]);

  const load = useCallback(async () => {
    const nextConfig = await getAppConfig();
    const [nextProviderSettings, nextLanguages, nextRemote] = await Promise.all([
      getProviderSettings(nextConfig.providerId),
      provisionCoreLanguages(),
      getRemoteControlStatus(),
    ]);
    setConfig(nextConfig);
    setProviderState(nextProviderSettings);
    setOnDevice(supportsOnDevice());
    setLanguages(nextLanguages);
    setRemote(nextRemote);
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const saveProviderConfig = async () => {
    Keyboard.dismiss();
    setSaveState('saving');
    setSaveMessage(null);
    try {
      const validation = await validateProviderSettings(config.providerId, providerSettings);
      if (!validation.ok || !validation.resolvedModel) {
        setSaveState('error');
        setSaveMessage(validation.message);
        log.warn('settings', 'provider validation failed', {
          providerId: config.providerId,
          message: validation.message,
        });
        return;
      }

      const nextConfig = await saveAppConfig(config);
      const nextProvider = await saveProviderSettings(config.providerId, {
        ...providerSettings,
        model: validation.resolvedModel,
        customBaseUrl: validation.normalizedBaseUrl ?? providerSettings.customBaseUrl,
      });
      setConfig(nextConfig);
      setProviderState(nextProvider);

      const queued = await queueEligibleMeetingPackets().catch(() => 0);
      const queuedMessage = queued > 0 ? ` · queued ${queued} existing meeting${queued === 1 ? '' : 's'}` : '';
      setSaveState('saved');
      setSaveMessage(`${validation.message}${queuedMessage}`);
      log.info('settings', 'provider setup saved', {
        providerId: config.providerId,
        model: validation.resolvedModel,
        queued,
      });
      setTimeout(() => setSaveState('idle'), 1800);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setSaveState('error');
      setSaveMessage(message);
      log.error('settings', 'provider setup save failed', {
        providerId: config.providerId,
        err: message,
      });
    }
  };

  const selectProvider = async (providerId: string) => {
    const nextConfig = await saveAppConfig({ providerId });
    const nextProvider = await getProviderSettings(providerId);
    setConfig(nextConfig);
    setProviderState(nextProvider);
    setSaveState('idle');
    setSaveMessage(null);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.bg }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          padding: space.lg,
          paddingTop: topPadding,
          gap: space.lg,
          paddingBottom: contentBottomPadding,
        }}
      >
      <Card style={{ gap: space.md, backgroundColor: theme.accent, borderColor: theme.accent }}>
        <AppText variant="display" color="#fff">Settings</AppText>
        <AppText variant="body" color="rgba(255,255,255,0.86)">
          Keep capture local, connect one cloud AI provider for packets, and control what Maina retains on the phone.
        </AppText>
      </Card>

      <Card style={{ gap: space.md }}>
        <AppText variant="label" muted>AI PACKET GENERATION</AppText>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md }}>
          <View style={{ flex: 1, gap: 4 }}>
            <AppText variant="heading">Auto-generate after every meeting</AppText>
            <AppText variant="label" muted>
              Maina keeps transcription local, then uses your chosen cloud LLM for the packet.
            </AppText>
          </View>
          <Switch
            value={config.autoSummarize}
            onValueChange={async (value) => {
              const next = await saveAppConfig({ autoSummarize: value });
              setConfig(next);
            }}
            thumbColor="#fff"
            trackColor={{ false: theme.border, true: theme.accent }}
          />
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {PROVIDERS.map((provider) => (
            <ProviderChip
              key={provider.id}
              provider={provider}
              selected={provider.id === config.providerId}
              onPress={() => void selectProvider(provider.id)}
            />
          ))}
        </View>

        <Input
          label="API key / token"
          value={providerSettings.apiKey}
          onChangeText={(value) => setProviderState((current) => ({ ...current, apiKey: value }))}
          secureTextEntry
          placeholder="Paste your provider key"
        />

        {selectedProvider.id === 'custom' ? (
          <View style={{ gap: space.md }}>
            <Input
              label="Base URL"
              value={providerSettings.customBaseUrl ?? ''}
              onChangeText={(value) => setProviderState((current) => ({ ...current, customBaseUrl: value }))}
              placeholder="https://api.example.com/v1"
            />
            <Input
              label="Model"
              value={providerSettings.model}
              onChangeText={(value) => setProviderState((current) => ({ ...current, model: value }))}
              placeholder="custom-model"
            />
          </View>
        ) : null}

        {selectedProvider.id !== 'custom' ? (
          <Card style={{ gap: space.sm, padding: space.md, backgroundColor: theme.accentWash, borderColor: theme.accentWash }}>
            <AppText variant="label" color={theme.accent}>Maina auto-selects the working model</AppText>
            <AppText variant="body" muted>
              Pick the provider and paste the key. On save, Maina validates it with a real request and locks onto a working model automatically.
            </AppText>
          </Card>
        ) : null}

        <View style={{ gap: space.md }}>
          <Pressable onPress={() => selectedProvider.keyUrl && void Linking.openURL(selectedProvider.keyUrl)} hitSlop={8}>
            <AppText variant="label" color={theme.accent}>
              {selectedProvider.keyUrl ? 'Open provider key page' : 'Custom provider'}
            </AppText>
          </Pressable>
          <PrimaryButton
            label={
              saveState === 'saving'
                ? 'Validating…'
                : saveState === 'saved'
                  ? 'Saved'
                  : 'Validate & save AI setup'
            }
            onPress={() => void saveProviderConfig()}
            style={{ minWidth: 156 }}
          />
          {saveMessage ? (
            <AppText
              variant="label"
              color={saveState === 'error' ? theme.warn : saveState === 'saved' ? theme.done : theme.muted}
            >
              {saveMessage}
            </AppText>
          ) : null}
          {config.autoSummarize ? (
            <AppText variant="label" muted>
              Auto-summary is on. Saving a valid provider now also re-queues older transcribed meetings.
            </AppText>
          ) : (
            <AppText variant="label" muted>
              Auto-summary is off. Meetings will stay transcript-only until you generate a packet manually.
            </AppText>
          )}
        </View>
      </Card>

      <Card style={{ gap: space.sm }}>
        <AppText variant="label" muted>MEETING PACKET</AppText>
        <Row label="Summary" value="Auto-generated after transcript" />
        <Row label="Decisions" value="Auto-generated with summary" />
        <Row label="To-dos" value="Auto-generated with summary" />
        <Row label="Transcript" value="Always kept locally" />
        <AppText variant="label" muted>
          Maina keeps the transcript as the source of truth. AI packet items are generated, replaceable, and safe to rebuild later with a different provider.
        </AppText>
      </Card>

      <Card style={{ gap: space.sm }}>
        <AppText variant="label" muted>REMOTE CONTROL</AppText>
        <Row label="Maina" value={remote?.armed ? 'Ready · armed' : 'Open Maina to arm'} />
        <Row label="Locked-screen control" value={remoteHealth.statusLabel} helper={remoteHealth.detail} />
        <Row label="Capture" value={remote?.captureState ?? 'Checking…'} />
        <Row label="Button" value={remote?.trustedRemoteName ?? 'Disconnected or asleep'} />
        <Row label="Last press" value={formatRemoteLastPress(remote)} />
        {remote?.accessibilityLastLifecycle && remote.accessibilityLastLifecycle !== 'never' ? (
          <Row
            label="Listener lifecycle"
            value={`${remote.accessibilityLastLifecycle} · ${new Date(remote.accessibilityLastLifecycleAt).toLocaleTimeString()}`}
          />
        ) : null}
        {remoteHealth.ctaAction === 'accessibility' ? (
          <Pressable onPress={() => void openRemoteAccessibilitySettings()} style={{ paddingTop: space.sm }}>
            <AppText variant="label" color={theme.accent}>
              {remoteHealth.ctaLabel ?? 'Open locked-screen button control'}
            </AppText>
          </Pressable>
        ) : null}
      </Card>

      <Card style={{ gap: space.sm }}>
        <AppText variant="label" muted>OFFLINE SPEECH</AppText>
        <AppText variant="label" muted>
          Maina provisions Indian English + Hindi automatically and keeps the live preview local on your phone.
        </AppText>
        {LANGUAGES.map((language) => {
          const installed = languages?.installed.some((item) => item.toLowerCase() === language.code.toLowerCase());
          return <Row key={language.code} label={language.label} value={installed ? 'Ready' : 'Installing…'} />;
        })}
        <Row label="Active switch set" value={ACTIVE_LANGUAGES.join(' + ')} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
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
                  : 'On-device supported · setup continues automatically'
                : 'On-device unavailable — Maina blocks capture to protect privacy'}
          </AppText>
        </View>
      </Card>

      <Card style={{ gap: space.sm }}>
        <AppText variant="label" muted>RETENTION</AppText>
        <Row label="Transcript" value="Always kept" />
        <Row label="Audio recovery window" value={`${config.audioRetentionDays} days or 1 GB`} />
        <Row label="Summary packet" value="Always kept" />
        <AppText variant="label" muted>
          Audio is temporary recovery material. Transcript, summary, decisions, and to-dos remain.
        </AppText>
      </Card>

      <Card style={{ gap: space.xs }}>
        <AppText variant="label" muted>ABOUT</AppText>
        <Row label="Version" value={version} />
        <Row label="Capture engine" value="Android on-device speech + durable WAV" />
        <Row label="Share format" value="Markdown packet" />
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
    </KeyboardAvoidingView>
  );
}

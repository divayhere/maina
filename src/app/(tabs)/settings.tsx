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
  provisionCoreLanguages,
  supportsOnDevice,
  type LanguageProvisioningState,
} from '@/core/transcription/nativeSpeech';
import { AppText, Banner, Card, Chip, PrimaryButton, SectionLabel } from '@/design/components';
import { DrawerMenu } from '@/design/shell';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { getRemoteControlStatus, openRemoteAccessibilitySettings } from '@/hardware/recording/foreground';
import { describeRemoteHealth } from '@/hardware/trigger/remoteHealth';
import type { RemoteControlStatus } from '../../../modules/maina-recorder/src';
import {
  DEFAULT_CONFIG,
  DEFAULT_MAINA_KNOWLEDGE_CLOUD_SETTINGS,
  getAppConfig,
  getMainaKnowledgeCloudSettings,
  getProviderSettings,
  saveAppConfig,
  saveMainaKnowledgeCloudSettings,
  saveProviderSettings,
  type AppConfig,
  type MainaKnowledgeCloudSettings,
  type ProviderSettings,
} from '@/services/config';
import { log } from '@/services/logger';
import { queueEligibleMainaKnowledgeCloudSyncs } from '@/services/mainaKnowledgeCloud';
import { queueEligibleMeetingPackets } from '@/services/meetingPacket';
import { validateProviderSettings } from '@/services/providerValidation';

function ProviderPill({
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
      style={({ pressed }) => [
        {
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: selected ? theme.primary : theme.border,
          backgroundColor: selected ? theme.accent : theme.surface,
          paddingHorizontal: 14,
          paddingVertical: 10,
          opacity: pressed ? 0.96 : 1,
        },
      ]}
    >
      <AppText variant="bodyStrong" color={selected ? theme.accentText : theme.text}>
        {provider.label}
      </AppText>
    </Pressable>
  );
}

function LabeledInput({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={{ gap: space.sm }}>
      <AppText variant="bodyStrong">{label}</AppText>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textSoft}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          minHeight: 52,
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.surface,
          borderRadius: radius.md,
          paddingHorizontal: 16,
          color: theme.text,
          fontSize: 16,
        }}
      />
    </View>
  );
}

function SettingsRow({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper?: string;
}) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
        <AppText variant="bodyStrong" style={{ flex: 1 }}>
          {label}
        </AppText>
        <AppText variant="meta" muted style={{ flexShrink: 1, textAlign: 'right' }}>
          {value}
        </AppText>
      </View>
      {helper ? (
        <AppText variant="meta" muted>
          {helper}
        </AppText>
      ) : null}
    </View>
  );
}

export default function SettingsScreen() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [providerSettings, setProviderState] = useState<ProviderSettings>({
    providerId: DEFAULT_CONFIG.providerId,
    apiKey: '',
    model: getProvider(DEFAULT_CONFIG.providerId)?.defaultModel ?? '',
    customBaseUrl: '',
  });
  const [knowledgeCloudSettings, setKnowledgeCloudSettings] = useState<MainaKnowledgeCloudSettings>(
    DEFAULT_MAINA_KNOWLEDGE_CLOUD_SETTINGS,
  );
  const [languages, setLanguages] = useState<LanguageProvisioningState | null>(null);
  const [onDevice, setOnDevice] = useState<boolean | null>(null);
  const [remote, setRemote] = useState<RemoteControlStatus | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [cloudSaveState, setCloudSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [cloudSaveMessage, setCloudSaveMessage] = useState<string | null>(null);

  const selectedProvider = useMemo(
    () => getProvider(config.providerId) ?? getProvider(DEFAULT_CONFIG.providerId)!,
    [config.providerId],
  );
  const remoteHealth = useMemo(() => describeRemoteHealth(remote), [remote]);

  const load = useCallback(async () => {
    const nextConfig = await getAppConfig();
    const [nextProviderSettings, nextLanguages, nextRemote, nextKnowledgeCloudSettings] = await Promise.all([
      getProviderSettings(nextConfig.providerId),
      provisionCoreLanguages(),
      getRemoteControlStatus(),
      getMainaKnowledgeCloudSettings(),
    ]);
    setConfig(nextConfig);
    setProviderState(nextProviderSettings);
    setKnowledgeCloudSettings(nextKnowledgeCloudSettings);
    setLanguages(nextLanguages);
    setRemote(nextRemote);
    setOnDevice(supportsOnDevice());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const aiAccountState = useMemo(() => {
    if (saveState === 'error') return 'unreachable';
    if (providerSettings.apiKey.trim()) return 'connected';
    return 'not-connected';
  }, [providerSettings.apiKey, saveState]);

  const saveProviderConfig = async () => {
    Keyboard.dismiss();
    setSaveState('saving');
    setSaveMessage(null);
    try {
      const validation = await validateProviderSettings(config.providerId, providerSettings);
      if (!validation.ok || !validation.resolvedModel) {
        setSaveState('error');
        setSaveMessage(validation.message);
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
      setSaveState('saved');
      setSaveMessage(
        queued > 0
          ? `${validation.message} · queued ${queued} earlier meeting${queued === 1 ? '' : 's'}`
          : validation.message,
      );
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

  const connectionBanner =
    aiAccountState === 'connected'
      ? {
          title: 'Your AI account is connected',
          body: 'Maina can write notes using your saved key.',
          tone: 'info' as const,
          chip: 'Connected',
          chipTone: 'primary' as const,
        }
      : aiAccountState === 'unreachable'
        ? {
            title: "We couldn't reach your AI account",
            body: 'Check the key or provider and try again.',
            tone: 'warn' as const,
            chip: 'Needs attention',
            chipTone: 'warn' as const,
        }
        : {
            title: 'Connect your AI account',
            body: 'Transcript stays local. Your AI account is only used to write notes.',
            tone: 'info' as const,
            chip: 'Setup required',
            chipTone: 'warn' as const,
          };

  const cloudBanner =
    knowledgeCloudSettings.enabled && knowledgeCloudSettings.token.trim() && knowledgeCloudSettings.baseUrl.trim()
      ? {
          title: 'Maina Knowledge Cloud is connected',
          body: 'Finalized meetings can sync to your private cloud memory automatically.',
          chip: 'Connected',
          chipTone: 'primary' as const,
        }
      : knowledgeCloudSettings.enabled
        ? {
            title: 'Maina Knowledge Cloud needs one more detail',
            body: 'Turn it on only after the base URL and access token are saved.',
            chip: 'Needs attention',
            chipTone: 'warn' as const,
          }
        : {
            title: 'Maina Knowledge Cloud is optional',
            body: 'Leave it off if you want Maina to keep everything only on this phone.',
            chip: 'Local only',
            chipTone: 'muted' as const,
          };

  const saveKnowledgeCloudConfig = async () => {
    Keyboard.dismiss();
    setCloudSaveState('saving');
    setCloudSaveMessage(null);
    try {
      const next = await saveMainaKnowledgeCloudSettings(knowledgeCloudSettings);
      setKnowledgeCloudSettings(next);
      const queued = next.enabled
        ? await queueEligibleMainaKnowledgeCloudSyncs({ includeAuthFailures: true }).catch(() => 0)
        : 0;
      setCloudSaveState('saved');
      setCloudSaveMessage(
        next.enabled
          ? queued > 0
            ? `Saved. Queued ${queued} earlier meeting${queued === 1 ? '' : 's'} for cloud sync.`
            : 'Saved. New finalized meetings can sync to Maina Knowledge Cloud.'
          : 'Saved. Meetings stay only on this phone until you turn cloud sync on again.',
      );
      setTimeout(() => setCloudSaveState('idle'), 1800);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setCloudSaveState('error');
      setCloudSaveMessage(message);
      log.error('settings', 'maina knowledge cloud settings save failed', { err: message });
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <DrawerMenu />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: topPadding,
          gap: space.lg,
          paddingBottom: contentBottomPadding,
        }}
      >
        <Card style={{ gap: space.xl }}>
          <SectionLabel>Your AI account</SectionLabel>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.md }}>
            <View style={{ flex: 1, gap: 6 }}>
              <AppText variant="title">{connectionBanner.title}</AppText>
              <AppText variant="body" muted>{connectionBanner.body}</AppText>
            </View>
            <Chip label={connectionBanner.chip} tone={connectionBanner.chipTone} />
          </View>
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md }}>
              <View style={{ flex: 1, gap: 4 }}>
                <AppText variant="bodyStrong">Write notes automatically</AppText>
                <AppText variant="meta" muted>
                  Maina keeps transcription local, then uses your chosen AI account for notes.
                </AppText>
              </View>
              <Switch
                value={config.autoSummarize}
                onValueChange={async (value) => {
                  const next = await saveAppConfig({ autoSummarize: value });
                  setConfig(next);
                }}
                thumbColor="#FFFFFF"
                trackColor={{ false: theme.border, true: theme.primary }}
              />
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {PROVIDERS.map((provider) => (
                <ProviderPill
                  key={provider.id}
                  provider={provider}
                  selected={provider.id === config.providerId}
                  onPress={() => void selectProvider(provider.id)}
                />
              ))}
            </View>

            <LabeledInput
              label="Paste the key from your AI account"
              value={providerSettings.apiKey}
              onChangeText={(value) => setProviderState((current) => ({ ...current, apiKey: value }))}
              placeholder="Paste your provider key"
              secureTextEntry
            />

            {selectedProvider.id === 'custom' ? (
              <View style={{ gap: space.md }}>
                <LabeledInput
                  label="Base URL"
                  value={providerSettings.customBaseUrl ?? ''}
                  onChangeText={(value) => setProviderState((current) => ({ ...current, customBaseUrl: value }))}
                  placeholder="https://api.example.com/v1"
                />
                <LabeledInput
                  label="Model"
                  value={providerSettings.model}
                  onChangeText={(value) => setProviderState((current) => ({ ...current, model: value }))}
                  placeholder="custom-model"
                />
              </View>
            ) : (
              <Banner tone="info" style={{ gap: 8 }}>
                <AppText variant="bodyStrong">Maina checks the key when you save.</AppText>
                <AppText variant="meta" muted>
                  Pick the provider and paste the key. On save, Maina validates it with a real request and locks onto a working model automatically.
                </AppText>
              </Banner>
            )}

            <View style={{ gap: space.md }}>
              <Pressable onPress={() => selectedProvider.keyUrl && void Linking.openURL(selectedProvider.keyUrl)} hitSlop={8}>
                <AppText variant="bodyStrong" color={theme.primary}>
                  {selectedProvider.keyUrl ? 'Where do I find my key?' : 'Custom provider'}
                </AppText>
              </Pressable>

              <PrimaryButton
                label={
                  saveState === 'saving'
                    ? 'Validating...'
                    : saveState === 'saved'
                      ? 'Saved'
                      : 'Save'
                }
                onPress={() => void saveProviderConfig()}
              />

              {saveMessage ? (
                <AppText variant="meta" color={saveState === 'error' ? theme.warn : saveState === 'saved' ? theme.primary : theme.textSoft}>
                  {saveMessage}
                </AppText>
              ) : null}
            </View>
          </View>
        </Card>

        <Card style={{ gap: space.xl }}>
          <SectionLabel>Maina Knowledge Cloud</SectionLabel>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.md }}>
            <View style={{ flex: 1, gap: 6 }}>
              <AppText variant="title">{cloudBanner.title}</AppText>
              <AppText variant="body" muted>{cloudBanner.body}</AppText>
            </View>
            <Chip label={cloudBanner.chip} tone={cloudBanner.chipTone} />
          </View>
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md }}>
              <View style={{ flex: 1, gap: 4 }}>
                <AppText variant="bodyStrong">Sync finalized meetings</AppText>
                <AppText variant="meta" muted>
                  Maina records and transcribes locally first, then sends one frozen meeting package to Maina Knowledge Cloud.
                </AppText>
              </View>
              <Switch
                value={knowledgeCloudSettings.enabled}
                onValueChange={(value) =>
                  setKnowledgeCloudSettings((current) => ({ ...current, enabled: value }))
                }
                thumbColor="#FFFFFF"
                trackColor={{ false: theme.border, true: theme.primary }}
              />
            </View>

            <LabeledInput
              label="Base URL"
              value={knowledgeCloudSettings.baseUrl}
              onChangeText={(value) =>
                setKnowledgeCloudSettings((current) => ({ ...current, baseUrl: value }))
              }
              placeholder="https://mkc-backend.maina-knowledge-cloud.workers.dev"
            />

            <LabeledInput
              label="Access token"
              value={knowledgeCloudSettings.token}
              onChangeText={(value) =>
                setKnowledgeCloudSettings((current) => ({ ...current, token: value }))
              }
              placeholder="Paste your Maina Knowledge Cloud token"
              secureTextEntry
            />

            <Banner tone="info" style={{ gap: 8 }}>
              <AppText variant="bodyStrong">Cloud sync never replaces the local meeting.</AppText>
              <AppText variant="meta" muted>
                If Maina Knowledge Cloud is unavailable, your meeting still stays on this phone and can sync later.
              </AppText>
            </Banner>

            <View style={{ gap: space.md }}>
              <PrimaryButton
                label={
                  cloudSaveState === 'saving'
                    ? 'Saving...'
                    : cloudSaveState === 'saved'
                      ? 'Saved'
                      : 'Save cloud settings'
                }
                onPress={() => void saveKnowledgeCloudConfig()}
              />

              {cloudSaveMessage ? (
                <AppText variant="meta" color={cloudSaveState === 'error' ? theme.warn : cloudSaveState === 'saved' ? theme.primary : theme.textSoft}>
                  {cloudSaveMessage}
                </AppText>
              ) : null}
            </View>
          </View>
        </Card>

        <Card style={{ gap: space.lg }}>
          <SectionLabel>Recording</SectionLabel>
          <SettingsRow
            label="Main language spoken"
            value="Detect automatically"
            helper="Maina detects English and Hindi automatically."
          />
          <SettingsRow
            label="Speech on this phone"
            value={languages?.ready ? 'Works offline' : 'Setting up'}
            helper="Maina works offline in English and Hindi."
          />
          <SettingsRow
            label="My clicker"
            value={remoteHealth.statusLabel}
            helper="Works with your configured clicker when Maina is armed. Android can turn this off after a restart."
          />
          {remoteHealth.ctaAction === 'accessibility' ? (
            <Pressable onPress={() => void openRemoteAccessibilitySettings()}>
              <AppText variant="bodyStrong" color={theme.primary}>
                {remoteHealth.ctaLabel ?? 'Open phone settings'}
              </AppText>
            </Pressable>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Ionicons
              name={onDevice ? 'phone-portrait-outline' : 'cloud-outline'}
              size={16}
              color={onDevice ? theme.primary : theme.warn}
            />
            <AppText variant="meta" muted style={{ flex: 1 }}>
              {onDevice === null
                ? 'Checking on-device support...'
                : onDevice
                  ? languages?.ready
                    ? 'On-device bilingual recognition ready'
                    : 'On-device supported. Setup continues automatically.'
                  : 'On-device unavailable. Maina blocks capture to protect privacy.'}
            </AppText>
          </View>
        </Card>

        <Card style={{ gap: space.lg }}>
          <SectionLabel>Privacy & storage</SectionLabel>
          <SettingsRow label="The text" value="Always kept" />
          <SettingsRow label="Audio" value={`${config.audioRetentionDays} days or 1 GB`} />
          <SettingsRow label="Your notes" value="Always kept" />
          <AppText variant="meta" muted>
            Whichever comes first. Maina removes the oldest audio the next time it runs. The text is always kept.
          </AppText>
        </Card>

        <Card style={{ gap: space.lg }}>
          <SectionLabel>About</SectionLabel>
          <SettingsRow label="Version" value={version} />
          <Pressable onPress={() => router.push('/help')}>
            <AppText variant="bodyStrong" color={theme.primary}>
              Help
            </AppText>
          </Pressable>
          <Pressable onPress={() => void Linking.openURL('mailto:hello@maina.app?subject=Maina%20feedback')}>
            <AppText variant="bodyStrong" color={theme.primary}>
              Send feedback
            </AppText>
          </Pressable>
          <Pressable onPress={() => router.push('/diagnostics')}>
            <AppText variant="bodyStrong" color={theme.primary}>
              System status
            </AppText>
          </Pressable>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

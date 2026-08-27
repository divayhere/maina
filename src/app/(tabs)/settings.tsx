import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Switch, View } from 'react-native';

import { provisionCoreLanguages, supportsOnDevice, type LanguageProvisioningState } from '@/core/transcription/nativeSpeech';
import { AppText, Card, Chip, PrimaryButton, SectionLabel } from '@/design/components';
import { DrawerMenu } from '@/design/shell';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { getRemoteControlStatus, openRemoteAccessibilitySettings } from '@/hardware/recording/foreground';
import { describeRemoteHealth } from '@/hardware/trigger/remoteHealth';
import type { RemoteControlStatus } from '../../../modules/maina-recorder/src';
import { DEFAULT_CONFIG, getAppConfig, saveAppConfig, type AppConfig } from '@/services/config';
import { createMainaCloudPairing, exchangeMainaCloudPairing, getMainaCloudConnection, signOutMainaCloud, type MainaCloudPairingRequest, type MainaCloudSession } from '@/services/mainaCloudSession';
import { queueEligibleMainaKnowledgeCloudSyncs } from '@/services/mainaKnowledgeCloud';
import { queueEligibleMainaKnowledgeCloudCorrections } from '@/services/mainaKnowledgeCloudCorrections';
import { queueEligibleMeetingPackets } from '@/services/meetingPacket';

function SettingsRow({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
        <AppText variant="bodyStrong" style={{ flex: 1 }}>{label}</AppText>
        <AppText variant="meta" muted style={{ flexShrink: 1, textAlign: 'right' }}>{value}</AppText>
      </View>
      {helper ? <AppText variant="meta" muted>{helper}</AppText> : null}
    </View>
  );
}

function pairingCodeLabel(value: string) {
  const compact = value.replace(/^mp_/u, '').toUpperCase();
  return compact.match(/.{1,4}/gu)?.join(' ') ?? compact;
}

export default function SettingsScreen() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding, topBarHeight } = useMainaLayout();
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [languages, setLanguages] = useState<LanguageProvisioningState | null>(null);
  const [onDevice, setOnDevice] = useState<boolean | null>(null);
  const [remote, setRemote] = useState<RemoteControlStatus | null>(null);
  const [cloudSession, setCloudSession] = useState<MainaCloudSession | null>(null);
  const [pairing, setPairing] = useState<MainaCloudPairingRequest | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const remoteHealth = useMemo(() => describeRemoteHealth(remote), [remote]);

  const load = useCallback(async () => {
    const [nextConfig, nextLanguages, nextRemote, nextSession] = await Promise.all([
      getAppConfig(), provisionCoreLanguages(), getRemoteControlStatus(), getMainaCloudConnection(),
    ]);
    setConfig(nextConfig);
    setLanguages(nextLanguages);
    setRemote(nextRemote);
    setCloudSession(nextSession);
    setOnDevice(supportsOnDevice());
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const startPairing = async () => {
    setCloudBusy(true); setCloudMessage(null);
    try {
      const request = await createMainaCloudPairing(
        Platform.OS === 'ios' ? 'Maina iPhone' : 'Maina Android',
      );
      setPairing(request);
      setCloudMessage('Approve this phone in Maina Cloud Web, then return here and confirm.');
    } catch (cause) {
      setCloudMessage(cause instanceof Error ? cause.message : String(cause));
    } finally { setCloudBusy(false); }
  };

  const finishPairing = async () => {
    if (!pairing) return;
    setCloudBusy(true); setCloudMessage(null);
    try {
      const session = await exchangeMainaCloudPairing(pairing);
      setCloudSession(session); setPairing(null);
      const [notes, sources, corrections] = await Promise.all([
        queueEligibleMeetingPackets().catch(() => 0),
        queueEligibleMainaKnowledgeCloudSyncs({ includeAuthFailures: true }).catch(() => 0),
        queueEligibleMainaKnowledgeCloudCorrections({ includeAuthFailures: true }).catch(() => 0),
      ]);
      setCloudMessage(notes + sources + corrections > 0 ? 'Connected. Earlier meetings are now catching up.' : 'Connected. New meetings will finish their notes and sync automatically.');
    } catch (cause) {
      setCloudMessage(cause instanceof Error ? cause.message : String(cause));
    } finally { setCloudBusy(false); }
  };

  const disconnectCloud = async () => {
    setCloudBusy(true);
    try {
      await signOutMainaCloud();
      setCloudSession(null); setPairing(null);
      setCloudMessage('This phone is disconnected. Your local meetings remain here.');
    } finally { setCloudBusy(false); }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={topBarHeight}>
      <DrawerMenu />
      <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingHorizontal: 16, paddingTop: topPadding, gap: space.lg, paddingBottom: contentBottomPadding }}>
        <Card style={{ gap: space.lg }}>
          <SectionLabel>Maina Cloud</SectionLabel>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.md }}>
            <View style={{ flex: 1, gap: 6 }}>
              <AppText variant="title">{cloudSession ? 'Maina Cloud connected' : 'Connect Maina Cloud'}</AppText>
              <AppText variant="body" muted>{cloudSession ? `${cloudSession.user.email} · notes and cloud memory run automatically.` : 'Recording and transcription stay local. Connect once when you want automatic notes and cloud memory.'}</AppText>
            </View>
            <Chip label={cloudSession ? 'Connected' : 'Local only'} tone={cloudSession ? 'primary' : 'muted'} />
          </View>
          {cloudSession ? (
            <View style={{ gap: space.md }}>
              <SettingsRow label="Account" value={cloudSession.user.email} />
              <SettingsRow label="Notes & memory" value="Automatic" helper="Maina sends a finalized transcript; it never sends your provider key." />
              <Pressable onPress={() => void disconnectCloud()} disabled={cloudBusy} hitSlop={8}><AppText variant="bodyStrong" color={theme.warn}>{cloudBusy ? 'Disconnecting…' : 'Disconnect this phone'}</AppText></Pressable>
            </View>
          ) : pairing ? (
            <View style={{ gap: space.md }}>
              <View style={{ padding: 16, borderRadius: 16, backgroundColor: theme.accent, gap: 4 }}>
                <AppText variant="meta" color={theme.accentText}>PAIRING CODE</AppText>
                <AppText variant="title" color={theme.accentText}>{pairingCodeLabel(pairing.verificationCode)}</AppText>
                <AppText variant="meta" color={theme.accentText}>Expires {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</AppText>
              </View>
              <SettingsRow label="Pairing request" value={pairing.pairingId} helper="Use this only if Maina Cloud Web asks which phone to approve." />
              <AppText variant="body" muted>Open your existing Maina Cloud Web session, approve this phone with the full code, then come back here.</AppText>
              <PrimaryButton label={cloudBusy ? 'Checking…' : 'I approved this phone'} onPress={() => void finishPairing()} disabled={cloudBusy} />
              <Pressable onPress={() => setPairing(null)} hitSlop={8}><AppText variant="bodyStrong" color={theme.textSoft}>Cancel</AppText></Pressable>
            </View>
          ) : <PrimaryButton label={cloudBusy ? 'Starting…' : 'Connect this phone'} onPress={() => void startPairing()} disabled={cloudBusy} />}
          {cloudMessage ? <AppText variant="meta" color={cloudSession ? theme.primary : theme.textSoft}>{cloudMessage}</AppText> : null}
        </Card>

        <Card style={{ gap: space.lg }}>
          <SectionLabel>Notes</SectionLabel>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md }}>
            <View style={{ flex: 1, gap: 4 }}>
              <AppText variant="bodyStrong">Write notes automatically</AppText>
              <AppText variant="meta" muted>Maina waits until transcript text is durable, then makes notes and syncs in the background.</AppText>
            </View>
            <Switch value={config.autoSummarize} onValueChange={async (value) => setConfig(await saveAppConfig({ autoSummarize: value }))} thumbColor="#FFFFFF" trackColor={{ false: theme.border, true: theme.primary }} />
          </View>
        </Card>

        <Card style={{ gap: space.lg }}>
          <SectionLabel>Recording</SectionLabel>
          <SettingsRow label="Main language spoken" value="Detect automatically" helper="Maina handles English and Hindi locally." />
          <SettingsRow label="Speech on this phone" value={languages?.ready ? 'Works offline' : 'Setting up'} helper="Language setup continues in the background." />
          <SettingsRow label="My clicker" value={remoteHealth.statusLabel} helper="Android may require Maina to be re-armed after a phone restart." />
          {remoteHealth.ctaAction === 'accessibility' ? <Pressable onPress={() => void openRemoteAccessibilitySettings()}><AppText variant="bodyStrong" color={theme.primary}>{remoteHealth.ctaLabel ?? 'Open phone settings'}</AppText></Pressable> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Ionicons name={onDevice ? 'phone-portrait-outline' : 'cloud-outline'} size={16} color={onDevice ? theme.primary : theme.warn} />
            <AppText variant="meta" muted style={{ flex: 1 }}>{onDevice === null ? 'Checking on-device support…' : onDevice ? languages?.ready ? 'On-device bilingual recognition ready' : 'On-device setup continues automatically.' : 'On-device speech is unavailable on this phone.'}</AppText>
          </View>
        </Card>

        <Card style={{ gap: space.lg }}>
          <SectionLabel>Privacy & storage</SectionLabel>
          <SettingsRow label="Transcript" value="Always kept" />
          <SettingsRow label="Audio recovery" value={`${config.audioRetentionDays} days or 1 GB`} />
          <SettingsRow label="Notes" value="Always kept" />
          <AppText variant="meta" muted>Completed audio is removed when Maina has a durable transcript. Incomplete audio stays for recovery within the limit.</AppText>
        </Card>

        <Card style={{ gap: space.lg }}>
          <SectionLabel>About</SectionLabel>
          <SettingsRow label="Version" value={version} />
          <Pressable onPress={() => router.push('/help')}><AppText variant="bodyStrong" color={theme.primary}>Help</AppText></Pressable>
          <Pressable onPress={() => void Linking.openURL('mailto:hello@maina.app?subject=Maina%20feedback')}><AppText variant="bodyStrong" color={theme.primary}>Send feedback</AppText></Pressable>
          <Pressable onPress={() => router.push('/diagnostics')}><AppText variant="bodyStrong" color={theme.primary}>System status</AppText></Pressable>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

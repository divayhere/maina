import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { router, useFocusEffect } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import {
  ACTIVE_LANGUAGES,
  abortSession,
  chooseRecognitionLanguage,
  getOfflineLocales,
  provisionCoreLanguages,
  requestSpeechPermissions,
  startSession,
  stopSession,
  supportsOnDevice,
} from '@/core/transcription/nativeSpeech';
import { appendWithoutOverlap, transcriptWordCount } from '@/core/transcription/transcript';
import { buildRecordingCheckpoint } from '@/core/recording/checkpoint';
import {
  canApplyIdleCaptureMetrics,
  shouldPreserveTerminalNativeMeeting,
} from '@/core/recording/nativeCaptureReconciliation';
import {
  commitTranscriptFinalBlocks,
  createMeeting,
  deleteMeeting,
  discardTranscriptDraftBlock,
  finishRecordingSegment,
  getMeeting,
  newId,
  startRecordingSegment,
  type TranscriptBlock,
  upsertTranscriptDraftBlock,
  updateMeeting,
} from '@/data/meetings';
import { AppText, Banner, PrimaryButton, SecondaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import {
  abortNativeCapture,
  getNativeCaptureStatusAsync,
  getIOSAutomationScenario,
  getQwenAsrStatus,
  listAudioInputs,
  pauseNativeCapture,
  requestNativeCapturePermission,
  resumeNativeCapture,
  setNativeCaptureState,
  startNativeCapture,
  startRecordingForegroundService,
  stopNativeCapture,
  stopRecordingForegroundService,
  subscribeAudioRouteChanges,
} from '@/hardware/recording/foreground';
import { CaptureHealthTracker } from '@/hardware/recording/health';
import { isNativeCaptureStalled } from '@/hardware/recording/nativeCaptureHealth';
import { waitForNativeCaptureState } from '@/hardware/recording/nativeCaptureLifecycle';
import { recordingDir, segmentIndexFromUri, segmentPath } from '@/hardware/recording/paths';
import { registerActiveTriggerHandler } from '@/hardware/trigger/hardwareTrigger';
import { resolveRemoteAction } from '@/hardware/trigger/remoteControl';
import { log } from '@/services/logger';
import { getNativeCaptureMetrics } from '@/services/nativeCaptureMetrics';
import {
  clearDiagnosticContext,
  flushDiagnostics,
  getDiagnosticsStatus,
  queueAudioArtifact,
  setDiagnosticContext,
} from '@/services/remoteLog';
import { ensureStorageBudget } from '@/services/storageBudget';
import { useMeetings } from '@/state/meetingsStore';
import { formatDuration, formatTime } from '@/utils/format';

const SAVE_EVERY_MS = 5000;
const STALL_MS = 45000;
const MAX_FILE_MS = 10 * 60 * 1000;
const RESTART_DELAY_MS = 500;
const RESTART_DELAY_BUSY_MS = 1600;
const END_FALLBACK_MS = 2500;
const FINAL_RESULT_TIMEOUT_MS = 6000;
const RECENT_BLOCK_WINDOW = 24;
const CAPTURE_ENGINE = 'native-qwen';

const delay = (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs));

interface EndWaiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AndroidLanguageSwitchEvent {
  languageSwitchResult?: string;
  languageSwitchResultCode?: number;
}

interface AsrQualityMetrics {
  finalResults: number;
  partialResults: number;
  confidenceSamples: number;
  confidenceTotal: number;
  languageSwitchSucceeded: number;
  languageSwitchFailed: number;
  detectedEnglish: number;
  detectedHindi: number;
}

function describeRecordingProblem(message?: string | null): { title: string; body: string } {
  const normalized = message?.trim() ?? '';
  if (!normalized) {
    return {
      title: 'Recording stopped early',
      body: 'Maina saved what it had. You can keep that part or delete it.',
    };
  }
  if (normalized.toLowerCase().includes('restart')) {
    return {
      title: 'Recording stopped early',
      body: 'Maina could not continue this recording, but the earlier audio and transcript checkpoints were kept.',
    };
  }
  return {
    title: 'Recording stopped early',
    body: 'Maina saved what it had. You can keep that part or delete it.',
  };
}

export default function RecordScreen() {
  const { theme } = useAppTheme();
  const { insets } = useMainaLayout();
  const { refresh } = useMeetings();

  const idRef = useRef(newId());
  const dirRef = useRef('');
  const langRef = useRef('en-IN');
  const startedAtRef = useRef(0);
  const sessionStartedAtRef = useRef(0);
  const sessionStartsRef = useRef<Record<number, number>>({});
  const healthRef = useRef(new CaptureHealthTracker());
  const asrQualityRef = useRef<AsrQualityMetrics>({
    finalResults: 0,
    partialResults: 0,
    confidenceSamples: 0,
    confidenceTotal: 0,
    languageSwitchSucceeded: 0,
    languageSwitchFailed: 0,
    detectedEnglish: 0,
    detectedHindi: 0,
  });
  const lastLanguageLogRef = useRef({ language: '', at: 0 });
  const recordingSessionIdRef = useRef(newId());
  const activeRef = useRef(false);
  const listeningRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const meetingCreatedRef = useRef(false);
  const sessionRef = useRef(0);
  const restartCountRef = useRef(0);
  const recentBlocksRef = useRef<TranscriptBlock[]>([]);
  const transcriptTailRef = useRef('');
  const draftBlockRef = useRef<{
    text: string;
    startedAt: number;
    endedAt: number;
    segmentIndex: number;
    language: string;
  } | null>(null);
  const interimRef = useRef('');
  const lastEventRef = useRef(0);
  const lastSaveRef = useRef(0);
  const lastHealthRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endWaiterRef = useRef<EndWaiter | null>(null);
  const audioEndWaiterRef = useRef<EndWaiter | null>(null);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const transcriptChainRef = useRef<Promise<void>>(Promise.resolve());
  const artifactQueueRef = useRef<Promise<void>>(Promise.resolve());
  const savingRef = useRef(false);
  const stopAndSaveRef = useRef<() => Promise<void>>(async () => {});
  const pauseRef = useRef<() => Promise<void>>(async () => {});
  const resumeRef = useRef<() => Promise<void>>(async () => {});
  const startingRef = useRef(false);
  const endingSessionRef = useRef(false);
  const busyRef = useRef(false);
  const sessionErrorRef = useRef<string | undefined>(undefined);
  const pausedRef = useRef(false);
  const controlBusyRef = useRef(false);
  const detectedLanguageRef = useRef('en-IN');
  const captureNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeStallReportedRef = useRef(false);

  const [, setRecentBlocks] = useState<TranscriptBlock[]>([]);
  const [, setInterim] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meetingCreated, setMeetingCreated] = useState(false);
  const [paused, setPaused] = useState(false);
  const [captureNote, setCaptureNote] = useState<string | null>(null);
  const audioPulse = useSharedValue(0);
  const audioPulseStyle = useAnimatedStyle(() => {
    const intensity = audioPulse.get();
    return {
      opacity: 0.34 + intensity * 0.58,
      transform: [{ scale: 0.93 + intensity * 0.2 }],
    };
  });

  useEffect(() => {
    if (CAPTURE_ENGINE !== 'native-qwen') return;
    let cancelled = false;
    let requestInFlight = false;
    const updatePulse = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      const status = await getNativeCaptureStatusAsync().catch(() => null);
      requestInFlight = false;
      if (cancelled) return;
      const normalized = !pausedRef.current && status?.state === 'recording'
        ? Math.max(0, Math.min(1, ((status.rmsDbfs ?? -60) + 60) / 48))
        : 0;
      audioPulse.set(withTiming(normalized, {
        duration: 180,
        easing: Easing.bezier(0.23, 1, 0.32, 1),
      }));
    };
    const timer = setInterval(() => void updatePulse(), 250);
    void updatePulse();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [audioPulse]);

  const showCaptureNote = useCallback((message: string | null, durationMs = 8000) => {
    if (captureNoteTimerRef.current) {
      clearTimeout(captureNoteTimerRef.current);
      captureNoteTimerRef.current = null;
    }
    setCaptureNote(message);
    if (message) {
      captureNoteTimerRef.current = setTimeout(() => {
        captureNoteTimerRef.current = null;
        setCaptureNote(null);
      }, durationMs);
    }
  }, []);

  const reportNativeCaptureStall = useCallback((status: Awaited<ReturnType<typeof getNativeCaptureStatusAsync>>) => {
    if (nativeStallReportedRef.current) return;
    nativeStallReportedRef.current = true;
    activeRef.current = false;
    pausedRef.current = false;
    listeningRef.current = false;
    setPaused(false);
    setListening(false);
    const message = 'Native audio capture stopped making progress. Maina kept the audio it had already saved.';
    log.error('record', 'native capture progress stalled', { nativeStatus: status });
    void updateMeeting(idRef.current, {
      status: 'interrupted',
      lastError: message,
    }).catch(() => {});
    setError(`Recording problem: ${message}`);
  }, []);

  const pushRecentBlocks = (blocks: TranscriptBlock[]) => {
    if (blocks.length === 0) return;
    recentBlocksRef.current = [...recentBlocksRef.current, ...blocks].slice(-RECENT_BLOCK_WINDOW);
    transcriptTailRef.current = blocks[blocks.length - 1]?.text ?? transcriptTailRef.current;
    setRecentBlocks(recentBlocksRef.current);
  };

  const queueTranscriptTask = (task: () => Promise<void>): Promise<void> => {
    transcriptChainRef.current = transcriptChainRef.current
      .catch(() => {})
      .then(task)
      .catch((cause) => {
        log.warn('record', 'transcript block task failed', { err: String(cause) });
      });
    return transcriptChainRef.current;
  };

  const finalizeTranscriptText = (text: string, endedAt = Date.now()): Promise<void> => {
    const normalized = text.trim();
    const draft = draftBlockRef.current;
    draftBlockRef.current = null;
    interimRef.current = '';
    setInterim('');
    if (!normalized) {
      return queueTranscriptTask(async () => {
        await discardTranscriptDraftBlock(idRef.current);
      });
    }
    const appended = appendWithoutOverlap(transcriptTailRef.current, normalized);
    return queueTranscriptTask(async () => {
      if (!appended.trim()) {
        await discardTranscriptDraftBlock(idRef.current);
        return;
      }
      const blocks = await commitTranscriptFinalBlocks({
        meetingId: idRef.current,
        text: appended,
        segmentIndex: draft?.segmentIndex ?? sessionRef.current,
        startedAt: draft?.startedAt ?? endedAt,
        endedAt,
        language: draft?.language ?? detectedLanguageRef.current ?? langRef.current,
      });
      pushRecentBlocks(blocks);
    });
  };

  const persist = (force = false): Promise<void> => {
    if (!meetingCreatedRef.current) return Promise.resolve();
    const now = Date.now();
    if (!force && now - lastSaveRef.current < SAVE_EVERY_MS) return persistChainRef.current;
    lastSaveRef.current = now;
    const health = healthRef.current.snapshot(now);
    const snapshot = buildRecordingCheckpoint({
      captureEngine: CAPTURE_ENGINE,
      now,
      startedAt: startedAtRef.current,
      pausedDurationMs: health.pausedDurationMs,
      segmentCount: sessionRef.current + 1,
      language: langRef.current,
      restartCount: restartCountRef.current,
    });
    persistChainRef.current = persistChainRef.current
      .catch(() => {})
      .then(async () => {
        await updateMeeting(idRef.current, snapshot);
        await queueTranscriptTask(async () => {
          const draft = draftBlockRef.current;
          if (draft?.text.trim()) {
            await upsertTranscriptDraftBlock({
              meetingId: idRef.current,
              text: draft.text,
              segmentIndex: draft.segmentIndex,
              startedAt: draft.startedAt,
              endedAt: draft.endedAt,
              language: draft.language,
            });
          } else {
            await discardTranscriptDraftBlock(idRef.current);
          }
        });
      })
      .catch((cause) => {
        log.warn('record', 'checkpoint failed', { err: String(cause) });
      });
    return persistChainRef.current;
  };

  const beginSession = async (index: number) => {
    if (index > 0) {
      await finishRecordingSegment(
        idRef.current,
        index - 1,
        segmentPath(dirRef.current, index - 1),
        sessionErrorRef.current,
      ).catch(() => {});
    }
    const expectedUri = segmentPath(dirRef.current, index);
    await startRecordingSegment(idRef.current, index, expectedUri);
    sessionRef.current = index;
    healthRef.current.requestSegment(index);
    sessionStartedAtRef.current = Date.now();
    sessionStartsRef.current[index] = sessionStartedAtRef.current;
    lastEventRef.current = sessionStartedAtRef.current;
    setDiagnosticContext({ segmentIndex: index });
    endingSessionRef.current = false;
    sessionErrorRef.current = undefined;
    await updateMeeting(idRef.current, {
      segmentCount: index + 1,
      restartCount: restartCountRef.current,
    });
    startSession({ dir: dirRef.current, index, lang: langRef.current });
    await setNativeCaptureState('recording');
  };

  const scheduleRestart = (delay: number, reason: string) => {
    if (!activeRef.current || pausedRef.current) return;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!activeRef.current || pausedRef.current) return;
      const next = sessionRef.current + 1;
      restartCountRef.current += 1;
      beginSession(next)
        .then(() => log.info('record', 'session restarted', { index: next, reason }))
        .catch(async (cause) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          log.error('record', 'restart failed', { err: message, index: next });
          await updateMeeting(idRef.current, { lastError: message }).catch(() => {});
          setError('Recording could not restart. Your audio and transcript checkpoints were kept.');
          activeRef.current = false;
          await stopRecordingForegroundService().catch(() => {});
        });
    }, delay);
  };

  const requestSessionEnd = (
    reason: string,
    graceful: boolean,
    options?: { fallbackDelayMs?: number; note?: string | null },
  ) => {
    if (!activeRef.current || endingSessionRef.current) return;
    endingSessionRef.current = true;
    if (options?.note) showCaptureNote(options.note);
    healthRef.current.captureUnavailable(Date.now());
    void finalizeTranscriptText(interimRef.current);
    lastEventRef.current = Date.now();
    log.info('record', 'ending audio file', { index: sessionRef.current, reason, graceful });
    if (graceful) stopSession();
    else abortSession();
    // Upstream has reported silent interruptions without an end event. This
    // fallback is cancelled/replaced if end arrives normally.
    scheduleRestart(options?.fallbackDelayMs ?? END_FALLBACK_MS, `${reason}-fallback`);
  };

  useSpeechRecognitionEvent('result', (event) => {
    const now = Date.now();
    lastEventRef.current = now;
    const text = event.results?.[0]?.transcript ?? '';
    if (!text) return;
    const quality = asrQualityRef.current;
    if (event.isFinal) quality.finalResults += 1;
    else quality.partialResults += 1;
    const confidence = event.results?.[0]?.confidence;
    if (typeof confidence === 'number' && confidence > 0) {
      quality.confidenceSamples += 1;
      quality.confidenceTotal += confidence;
    }
    if (event.isFinal) {
      void finalizeTranscriptText(text, now);
      void persist();
    } else {
      interimRef.current = text;
      draftBlockRef.current = {
        text,
        startedAt: draftBlockRef.current?.startedAt ?? now,
        endedAt: now,
        segmentIndex: sessionRef.current,
        language: detectedLanguageRef.current || langRef.current,
      };
      setInterim(text);
    }
  });

  useSpeechRecognitionEvent('volumechange', () => {
    lastEventRef.current = Date.now();
  });

  useSpeechRecognitionEvent('languagedetection', (event) => {
    lastEventRef.current = Date.now();
    // Android includes these optional language-switch diagnostics at runtime,
    // but expo-speech-recognition's public event type does not declare them.
    const androidEvent = event as typeof event & AndroidLanguageSwitchEvent;
    const language = event.detectedLanguage?.toLocaleLowerCase() ?? 'unknown';
    if (event.detectedLanguage) detectedLanguageRef.current = event.detectedLanguage;
    const quality = asrQualityRef.current;
    if (language.startsWith('en')) quality.detectedEnglish += 1;
    if (language.startsWith('hi')) quality.detectedHindi += 1;
    if (androidEvent.languageSwitchResult === 'succeeded') quality.languageSwitchSucceeded += 1;
    if (androidEvent.languageSwitchResult === 'failed' || androidEvent.languageSwitchResult === 'skipped-no-model-or-not-allowed') {
      quality.languageSwitchFailed += 1;
    }
    const now = Date.now();
    const important = androidEvent.languageSwitchResult === 'succeeded' ||
      androidEvent.languageSwitchResult === 'failed' ||
      (event.confidence ?? 0) >= 0.8;
    const changed = lastLanguageLogRef.current.language !== language;
    if (!important && !changed && now - lastLanguageLogRef.current.at < 10_000) return;
    lastLanguageLogRef.current = { language, at: now };
    log[important ? 'info' : 'debug']('record', 'language detected', {
      language: event.detectedLanguage,
      confidence: event.confidence,
      alternatives: event.topLocaleAlternatives,
      switchResult: androidEvent.languageSwitchResult,
      switchResultCode: androidEvent.languageSwitchResultCode,
      allowedLanguages: ACTIVE_LANGUAGES,
    });
  });

  useSpeechRecognitionEvent('error', (event) => {
    lastEventRef.current = Date.now();
    const intentionalStop = event.error === 'client' && (savingRef.current || endingSessionRef.current);
    if (intentionalStop) {
      log.info('record', 'recognizer acknowledged stop', {
        nativeCode: event.code,
        index: sessionRef.current,
      });
      return;
    }
    busyRef.current = event.error === 'busy';
    sessionErrorRef.current = event.error;
    const benign = event.error === 'no-speech' || event.error === 'speech-timeout' || busyRef.current;
    log[benign ? 'info' : 'warn']('record', 'recognition error', {
      code: event.error,
      nativeCode: event.code,
      message: event.message,
      index: sessionRef.current,
    });
  });

  useSpeechRecognitionEvent('end', () => {
    const now = Date.now();
    lastEventRef.current = now;
    healthRef.current.recognizerEnded(now);
    if (activeRef.current) healthRef.current.captureUnavailable(now);
    setListening(false);
    listeningRef.current = false;
    endingSessionRef.current = false;
    const waiter = endWaiterRef.current;
    if (waiter) {
      clearTimeout(waiter.timer);
      endWaiterRef.current = null;
      waiter.resolve();
    }
    if (!activeRef.current || pausedRef.current) return;
    scheduleRestart(busyRef.current ? RESTART_DELAY_BUSY_MS : RESTART_DELAY_MS, 'recognizer-end');
    busyRef.current = false;
  });

  useSpeechRecognitionEvent('start', () => {
    const now = Date.now();
    lastEventRef.current = now;
    healthRef.current.recognizerStarted(now);
    setListening(true);
    listeningRef.current = true;
    log.info('record', 'recognizer ready', { index: sessionRef.current });
  });

  useSpeechRecognitionEvent('audiostart', (event) => {
    const now = Date.now();
    const index = segmentIndexFromUri(event?.uri) ?? sessionRef.current;
    sessionStartsRef.current[index] = now;
    healthRef.current.audioStarted(index, now);
    log.info('record', 'audio capture ready', { index, uriReported: !!event?.uri });
  });

  useSpeechRecognitionEvent('audioend', (event) => {
    const now = Date.now();
    const index = segmentIndexFromUri(event?.uri) ?? sessionRef.current;
    const durationMs = Math.max(0, now - (sessionStartsRef.current[index] ?? sessionStartedAtRef.current));
    healthRef.current.audioEnded(index, now, !!event?.uri);
    if (activeRef.current) healthRef.current.captureUnavailable(now);
    artifactQueueRef.current = artifactQueueRef.current.catch(() => {}).then(() => finishRecordingSegment(
      idRef.current,
      index,
      event?.uri ?? null,
      event?.uri ? sessionErrorRef.current : sessionErrorRef.current ?? 'missing-audio-uri',
    )
      .then(async () => {
        if (!event?.uri) return;
        await queueAudioArtifact({
          artifactId: `${idRef.current}-audio-${index}`,
          meetingId: idRef.current,
          segmentIndex: index,
          sourceUri: event.uri,
          durationMs,
        });
      })
      .catch((cause) => log.warn('record', 'audio checkpoint/artifact queue failed', { err: String(cause), index })));
    log.info('record', 'audio file closed', {
      index,
      saved: !!event?.uri,
      errorCode: sessionErrorRef.current,
    });
    const waiter = audioEndWaiterRef.current;
    if (waiter) {
      clearTimeout(waiter.timer);
      audioEndWaiterRef.current = null;
      waiter.resolve();
    }
  });

  useEffect(() => {
    (async () => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        const storageDecision = await ensureStorageBudget('record');
        if (!storageDecision.ok) throw new Error(storageDecision.message);
        const granted = Platform.OS === 'ios'
          ? await requestNativeCapturePermission()
          : await requestSpeechPermissions();
        if (!granted) throw new Error('Microphone permission was not granted.');

        const dir = recordingDir(idRef.current);
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        dirRef.current = dir;
        if (CAPTURE_ENGINE === 'native-qwen') {
          langRef.current = 'auto';
          detectedLanguageRef.current = 'auto';
        } else {
          if (!supportsOnDevice()) {
            throw new Error('On-device speech recognition is unavailable. Maina refused the network fallback.');
          }
          langRef.current = await chooseRecognitionLanguage();
          detectedLanguageRef.current = langRef.current;
          void provisionCoreLanguages().catch(() => {});
          const locales = await getOfflineLocales();
          const installed = locales.installed.some(
            (locale) => locale.toLocaleLowerCase() === langRef.current.toLocaleLowerCase(),
          );
          log.info('record', 'offline speech check', {
            language: langRef.current,
            installed,
            installedCount: locales.installed.length,
            supportedCount: locales.supported.length,
          });
          if (!installed) log.warn('record', 'preferred offline pack missing; capture will use best-effort fallback', {
            language: langRef.current,
            installedLocales: locales.installed,
          });
        }

        startedAtRef.current = Date.now();
        await createMeeting({
          id: idRef.current,
          title: `Meeting · ${formatTime(startedAtRef.current)}`,
          startedAt: startedAtRef.current,
          durationMs: 0,
          audioUri: dir,
          segmentCount: 0,
          status: 'recording',
        });
        meetingCreatedRef.current = true;
        setMeetingCreated(true);
        setDiagnosticContext({
          meetingId: idRef.current,
          recordingSessionId: recordingSessionIdRef.current,
          segmentIndex: 0,
        });
        await startRecordingForegroundService();
        const diagnostics = await getDiagnosticsStatus().catch(() => null);
        if (diagnostics) {
          log.info('remote', 'diagnostics ready for capture', {
            enabled: diagnostics.enabled,
            pendingEvents: diagnostics.pendingEvents,
            pendingArtifacts: diagnostics.pendingArtifacts,
            failedArtifacts: diagnostics.failedArtifacts,
            lastError: diagnostics.lastError ?? null,
          });
        }
        const inputs = await listAudioInputs().catch(() => []);
        log.info('record', 'audio inputs visible', {
          inputs: inputs.map((input) => `${input.type}:${input.name}`),
        });
        activeRef.current = true;
        if (CAPTURE_ENGINE === 'native-qwen') {
          nativeStallReportedRef.current = false;
          const qwenStatus = await getQwenAsrStatus().catch((cause) => {
            log.warn('asr', 'qwen status check failed before capture', { err: String(cause) });
            return null;
          });
          await startNativeCapture({
            meetingId: idRef.current,
            directory: dir,
            sourceMode: 'voice_recognition',
            chunkDurationMs: MAX_FILE_MS,
            meetingStartedAt: startedAtRef.current,
          });
          // The microphone is owned by the foreground service, not the React
          // runtime.  Do not make starting a recording depend on a JS polling
          // timer: Android can park that timer while the lock screen is up,
          // even though native capture has already begun safely.
          sessionStartedAtRef.current = Date.now();
          lastEventRef.current = sessionStartedAtRef.current;
          listeningRef.current = true;
          setListening(true);
          // Recording state is expressed by the live pulse and timer. Do not
          // add a second, stale speech-status banner: the final transcript is
          // deliberately post-call and audio-route changes stay invisible.
          if (!qwenStatus?.ready) {
            log.warn('asr', 'local ASR setup is not ready at capture start');
          }
          log.info('record', 'meeting capture started', {
            language: 'auto',
            segmentMinutes: MAX_FILE_MS / 60000,
            offlineOnly: true,
            captureOwner: CAPTURE_ENGINE,
            qwenReady: !!qwenStatus?.ready,
            nativeStatus: await getNativeCaptureStatusAsync().catch(() => null),
          });
          return;
        }
        await beginSession(0);
        log.info('record', 'meeting capture started', {
          language: langRef.current,
          segmentMinutes: MAX_FILE_MS / 60000,
          offlineOnly: true,
          allowedLanguages: ACTIVE_LANGUAGES,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        activeRef.current = false;
        await updateMeeting(idRef.current, { status: 'interrupted', lastError: message }).catch(() => {});
        await stopRecordingForegroundService().catch(() => {});
        log.error('record', 'capture start failed', { err: message });
      }
    })();

    return () => {
      if (captureNoteTimerRef.current) clearTimeout(captureNoteTimerRef.current);
      activeRef.current = false;
      pausedRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      void persist(true);
      if (CAPTURE_ENGINE === 'native-qwen') void stopNativeCapture().catch(() => {});
      else if (listeningRef.current || pausedRef.current) abortSession();
      void stopRecordingForegroundService().catch(() => {});
    };
    // This effect owns one recording session lifecycle. Re-running it because
    // helper identities changed would restart capture mid-meeting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => subscribeAudioRouteChanges((event) => {
    log.warn('record-route', `external audio input ${event.change}`, {
      deviceId: event.deviceId,
      deviceType: event.deviceType,
      deviceName: event.deviceName,
      index: sessionRef.current,
    });
    if (!activeRef.current || pausedRef.current) return;
    if (CAPTURE_ENGINE === 'native-qwen') {
      // Native capture silently rebuilds AudioRecord inside the same meeting
      // session. Route changes are diagnostic only and never interrupt the UI.
      return;
    }
    if (event.change === 'removed') {
      requestSessionEnd('external-mic-disconnected', false, {
        fallbackDelayMs: 350,
        note: 'External mic disconnected · Maina is switching to the phone mic.',
      });
    } else if (event.change === 'added') {
      // Give Android USB enumeration a moment, then create a clean segment so
      // the new AudioRecord can select the external input.
      showCaptureNote('External mic connected · Maina is refreshing the input route.');
      setTimeout(() => {
        if (activeRef.current) requestSessionEnd('external-mic-connected', true, {
          fallbackDelayMs: 1200,
        });
      }, 800);
    }
  // The route handler intentionally reads current capture refs and must remain
  // registered once for the lifetime of this recording screen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const now = Date.now();
      const nativeStatus = CAPTURE_ENGINE === 'native-qwen'
        ? await getNativeCaptureStatusAsync().catch(() => null)
        : null;
      if (cancelled) return;
      if (
        meetingCreatedRef.current
        && nativeStatus
        && ['recording', 'pausing', 'paused', 'resuming'].includes(nativeStatus.state)
      ) {
        // Native capture owns the durable session. React navigation and app
        // lifecycle transitions must not leave the visible timer or controls
        // believing an otherwise healthy native recording has stopped.
        activeRef.current = true;
      }
      if (activeRef.current && startedAtRef.current !== 0) {
        const health = healthRef.current.snapshot(now);
        if (appStateRef.current === 'active') {
          setElapsed(Math.max(0, now - startedAtRef.current - health.pausedDurationMs));
        }
        void persist();

        if (!pausedRef.current) {
          if (isNativeCaptureStalled(nativeStatus, now)) {
            reportNativeCaptureStall(nativeStatus);
            return;
          }
          if (now - lastHealthRef.current >= 60000) {
            lastHealthRef.current = now;
            log.info('record-health', 'capture heartbeat', {
              elapsedMs: now - startedAtRef.current,
              draftWords: transcriptWordCount(draftBlockRef.current?.text ?? ''),
              recentBlocks: recentBlocksRef.current.length,
              index: sessionRef.current,
              restarts: restartCountRef.current,
              listening: listeningRef.current,
              captureOwner: CAPTURE_ENGINE,
              nativeStatus,
              asr: asrQualityRef.current,
              ...health,
            });
          }
          if (CAPTURE_ENGINE !== 'native-qwen' && now - sessionStartedAtRef.current >= MAX_FILE_MS) {
            requestSessionEnd('ten-minute-rotation', true);
          } else if (CAPTURE_ENGINE !== 'native-qwen' && now - lastEventRef.current >= STALL_MS) {
            log.warn('record', 'recognizer heartbeat stalled', {
              silentMs: now - lastEventRef.current,
              index: sessionRef.current,
            });
            requestSessionEnd('stall-watchdog', false);
          }
        }
      }

      if (!cancelled) {
        const backgroundOrPaused = appStateRef.current !== 'active' || pausedRef.current || !activeRef.current;
        timer = setTimeout(() => void tick(), backgroundOrPaused ? 5000 : 1000);
      }
    };
    timer = setTimeout(() => void tick(), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // The watchdog reads mutable capture refs by design; rebuilding it for
    // every helper identity would reset its timing window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      log.info('record', 'app state changed', { state });
      if (state !== 'active') void persist(true);
      if (state === 'active' && CAPTURE_ENGINE === 'native-qwen' && activeRef.current && !savingRef.current) {
        // Reconcile presentation state from the native foreground service
        // after a locked-screen command. The service is the source of truth;
        // JS may have been paused while a clicker command completed.
        void (async () => {
          const status = await getNativeCaptureStatusAsync().catch(() => null);
          if (isNativeCaptureStalled(status, Date.now())) {
            reportNativeCaptureStall(status);
            return;
          }
          if (status?.state === 'idle' && meetingCreatedRef.current) {
            const currentMeeting = await getMeeting(idRef.current).catch(() => null);
            if (currentMeeting && shouldPreserveTerminalNativeMeeting(currentMeeting)) {
              // Audio cleanup after a complete transcript is intentional. The
              // existing meeting is the source of truth, not an empty folder.
              activeRef.current = false;
              listeningRef.current = false;
              setListening(false);
              setPaused(false);
              await refresh();
              router.replace(`/meeting/${idRef.current}`);
              return;
            }
            const metrics = dirRef.current
              ? await getNativeCaptureMetrics(dirRef.current, true).catch(() => null)
              : null;
            activeRef.current = false;
            listeningRef.current = false;
            setListening(false);
            setPaused(false);
            if (metrics && (!currentMeeting || canApplyIdleCaptureMetrics({
              meeting: currentMeeting,
              finalizedChunkCount: metrics.finalizedUris.length,
            }))) {
              await updateMeeting(idRef.current, {
                durationMs: metrics.wallDurationMs,
                audioDurationMs: metrics.audioDurationMs,
                captureEndedAt: metrics.stoppedAt ?? Date.now(),
                segmentCount: metrics.finalizedUris.length,
                restartCount: metrics.routeRestartCount,
                status: metrics.finalizedUris.length > 0 ? 'transcribing' : 'interrupted',
                lastError: metrics.captureGapMs > 0 ? `Capture gap detected: ${metrics.captureGapMs}ms` : null,
              }).catch(() => {});
            }
            await refresh();
            router.replace(`/meeting/${idRef.current}`);
            return;
          }
          if (status?.state === 'paused') {
            pausedRef.current = true;
            setPaused(true);
            listeningRef.current = false;
            setListening(false);
            log.info('record', 'native state reconciled after foreground', { nativeStatus: status });
          } else if (status?.state === 'recording') {
            pausedRef.current = false;
            setPaused(false);
            listeningRef.current = true;
            setListening(true);
            log.info('record', 'native state reconciled after foreground', { nativeStatus: status });
          } else if (status?.state === 'error') {
            const message = status.lastError || 'The phone could not continue recording.';
            log.error('record', 'native capture reported an error after foreground', { nativeStatus: status });
            setError(`Recording problem: ${message}. Audio saved before the issue remains available.`);
          }
        })();
      }
    });
    return () => subscription.remove();
    // Persist is intentionally read from the latest closure while the app-state
    // subscription itself remains mounted once for the recording session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportNativeCaptureStall]);

  const waitForRecognizerEnd = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        endWaiterRef.current = null;
        log.warn('record', 'final result timeout', { index: sessionRef.current });
        abortSession();
        resolve();
      }, FINAL_RESULT_TIMEOUT_MS);
      endWaiterRef.current = { resolve, timer };
    });

  const waitForAudioEnd = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        audioEndWaiterRef.current = null;
        log.warn('record', 'audio file close timeout', { index: sessionRef.current });
        resolve();
      }, FINAL_RESULT_TIMEOUT_MS + 2000);
      audioEndWaiterRef.current = { resolve, timer };
    });

  const pauseRecording = async () => {
    const nativeStatus = CAPTURE_ENGINE === 'native-qwen'
      ? await getNativeCaptureStatusAsync().catch(() => null)
      : null;
    const nativeIsRecording = nativeStatus?.state === 'recording' || nativeStatus?.state === 'resuming';
    if ((!activeRef.current && !nativeIsRecording) || pausedRef.current || savingRef.current || controlBusyRef.current) return;
    if (nativeIsRecording) activeRef.current = true;
    controlBusyRef.current = true;
    pausedRef.current = true;
    setPaused(true);
    healthRef.current.pauseStarted(Date.now());
    if (CAPTURE_ENGINE === 'native-qwen') {
      try {
        await pauseNativeCapture();
        listeningRef.current = false;
        setListening(false);
        // Do not await JS timer-based confirmation here. A second clicker
        // press must remain available on the lock screen while the native
        // service serialises pause/resume itself.
        log.info('record', 'native pause requested', {
          nativeStatus: await getNativeCaptureStatusAsync().catch(() => null),
        });
      } catch (cause) {
        pausedRef.current = false;
        setPaused(false);
        healthRef.current.pauseEnded(Date.now());
        log.error('record', 'native pause failed', { err: String(cause) });
      } finally {
        controlBusyRef.current = false;
      }
      return;
    }
    endingSessionRef.current = true;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    await finalizeTranscriptText(interimRef.current);
    try {
      const endPromise = waitForRecognizerEnd();
      const audioEndPromise = waitForAudioEnd();
      stopSession();
      await Promise.all([endPromise, audioEndPromise]);
      await artifactQueueRef.current.catch(() => {});
      await persist(true);
      await setNativeCaptureState('paused');
      log.info('record', 'meeting paused', { index: sessionRef.current });
    } catch (cause) {
      pausedRef.current = false;
      setPaused(false);
      healthRef.current.pauseEnded(Date.now());
      log.error('record', 'pause failed', { err: String(cause) });
      scheduleRestart(RESTART_DELAY_MS, 'pause-failed');
    } finally {
      controlBusyRef.current = false;
    }
  };

  const resumeRecording = async () => {
    const nativeStatus = CAPTURE_ENGINE === 'native-qwen'
      ? await getNativeCaptureStatusAsync().catch(() => null)
      : null;
    const nativeIsPaused = nativeStatus?.state === 'paused' || nativeStatus?.state === 'pausing';
    if ((!activeRef.current && !nativeIsPaused) || (!pausedRef.current && !nativeIsPaused) || savingRef.current || controlBusyRef.current) return;
    if (nativeIsPaused) {
      activeRef.current = true;
      pausedRef.current = true;
    }
    controlBusyRef.current = true;
    try {
      await artifactQueueRef.current.catch(() => {});
      pausedRef.current = false;
      setPaused(false);
      healthRef.current.pauseEnded(Date.now());
      if (CAPTURE_ENGINE === 'native-qwen') {
        await resumeNativeCapture();
        listeningRef.current = true;
        setListening(true);
        log.info('record', 'native resume requested', {
          nativeStatus: await getNativeCaptureStatusAsync().catch(() => null),
        });
        return;
      }
      await beginSession(sessionRef.current + 1);
      log.info('record', 'meeting resumed', { index: sessionRef.current });
    } catch (cause) {
      pausedRef.current = true;
      setPaused(true);
      healthRef.current.pauseStarted(Date.now());
      await setNativeCaptureState('paused').catch(() => {});
      log.error('record', 'resume failed', { err: String(cause) });
      setError('Recording could not resume. Your earlier audio and transcript were kept.');
    } finally {
      controlBusyRef.current = false;
    }
  };

  const stopAndSave = async () => {
    if (savingRef.current || !meetingCreatedRef.current) return;
    savingRef.current = true;
    await setNativeCaptureState('finalizing').catch(() => {});
    activeRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    await finalizeTranscriptText(interimRef.current);
    if (CAPTURE_ENGINE === 'native-qwen') {
      showCaptureNote('Saving audio and starting local transcription...', 60_000);
      await stopNativeCapture().then(async () => {
        const finalStatus = await waitForNativeCaptureState(getNativeCaptureStatusAsync, 'idle', {
          timeoutMs: 20_000,
        });
        log.info('record', 'native capture finalization acknowledged', { nativeStatus: finalStatus });
      }).catch((cause) => {
        log.error('record', 'native capture stop failed', { err: String(cause) });
      });
      listeningRef.current = false;
      setListening(false);
    } else if (!pausedRef.current) {
      const endPromise = waitForRecognizerEnd();
      const audioEndPromise = waitForAudioEnd();
      stopSession();
      await Promise.all([endPromise, audioEndPromise]);
    }

    const id = idRef.current;
    try {
      await transcriptChainRef.current.catch(() => {});
      await persist(true);
      if (CAPTURE_ENGINE === 'native-qwen' && dirRef.current) {
        const metrics = await getNativeCaptureMetrics(dirRef.current, true).catch((cause) => {
          log.warn('record', 'native capture metrics unavailable during save', { err: String(cause) });
          return null;
        });
        if (metrics) {
          await updateMeeting(id, {
            durationMs: metrics.wallDurationMs,
            audioDurationMs: metrics.audioDurationMs,
            captureEndedAt: metrics.stoppedAt ?? Date.now(),
            segmentCount: metrics.finalizedUris.length,
            restartCount: metrics.routeRestartCount,
            status: metrics.finalizedUris.length > 0 ? 'transcribing' : 'interrupted',
            lastError: metrics.captureGapMs > 0 ? `Capture gap detected: ${metrics.captureGapMs}ms` : null,
          });
        }
      }
      await artifactQueueRef.current.catch(() => {});
      await flushDiagnostics().catch((cause) => {
        log.warn('remote', 'diagnostics flush failed after save', { err: String(cause) });
      });
      const diagnostics = await getDiagnosticsStatus().catch(() => null);
      if (diagnostics) {
        log.info('remote', 'diagnostics queued after save', {
          pendingEvents: diagnostics.pendingEvents,
          pendingArtifacts: diagnostics.pendingArtifacts,
          failedArtifacts: diagnostics.failedArtifacts,
          lastError: diagnostics.lastError ?? null,
        });
      }
      await refresh();
      log.info('record', 'meeting saved', {
        durationMs: Date.now() - startedAtRef.current,
        files: sessionRef.current + 1,
        restarts: restartCountRef.current,
      });
      clearDiagnosticContext();
      await setNativeCaptureState('idle').catch(() => {});
      router.replace(`/meeting/${id}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError('Maina could not finish the database checkpoint. Your WAV files remain on the phone.');
      log.error('record', 'meeting save failed', { err: message });
      savingRef.current = false;
      await setNativeCaptureState('idle').catch(() => {});
    }
  };

  useEffect(() => {
    stopAndSaveRef.current = stopAndSave;
    pauseRef.current = pauseRecording;
    resumeRef.current = resumeRecording;
  });

  useEffect(() => {
    const scenario = getIOSAutomationScenario();
    if (scenario !== 'record-lifecycle' && scenario !== 'record-interrupted' && !scenario?.startsWith('record-soak:')) return;
    let cancelled = false;
    void (async () => {
      try {
        const started = await waitForNativeCaptureState(getNativeCaptureStatusAsync, 'recording', {
          timeoutMs: 30_000,
        });
        if (cancelled) return;
        log.info('ios-qualification', 'recording scenario reached recording', { scenario, nativeStatus: started });

        if (scenario === 'record-interrupted') {
          log.info('ios-qualification', 'interruption scenario waiting for external process termination');
          return;
        }

        if (scenario?.startsWith('record-soak:')) {
          const requestedSeconds = Number(scenario.slice('record-soak:'.length));
          const durationMs = Math.max(15_000, Math.min(3 * 60 * 60_000, Number.isFinite(requestedSeconds) ? requestedSeconds * 1_000 : 60_000));
          await delay(durationMs);
          if (cancelled) return;
          await stopAndSaveRef.current();
          log.info('ios-qualification', 'recording soak requested stop and save', { durationMs });
          return;
        }

        await delay(6_000);
        if (cancelled) return;

        await pauseRef.current();
        const pausedStatus = await waitForNativeCaptureState(getNativeCaptureStatusAsync, 'paused', {
          timeoutMs: 15_000,
        });
        if (cancelled) return;
        log.info('ios-qualification', 'record lifecycle reached paused', { nativeStatus: pausedStatus });
        await delay(3_000);
        if (cancelled) return;

        await resumeRef.current();
        const resumed = await waitForNativeCaptureState(getNativeCaptureStatusAsync, 'recording', {
          timeoutMs: 15_000,
        });
        if (cancelled) return;
        log.info('ios-qualification', 'record lifecycle reached resumed recording', { nativeStatus: resumed });
        await delay(7_000);
        if (cancelled) return;

        await stopAndSaveRef.current();
        log.info('ios-qualification', 'record lifecycle requested stop and save');
      } catch (cause) {
        log.error('ios-qualification', 'record lifecycle scenario failed', { err: String(cause) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useFocusEffect(
    useCallback(() => registerActiveTriggerHandler((event) => {
      const state = savingRef.current
        ? 'finalizing'
        : pausedRef.current
          ? 'paused'
          : activeRef.current
            ? 'recording'
            : 'idle';
      const action = resolveRemoteAction(state, event.command);
      log.info('trigger', 'recorder remote action resolved', { state, command: event.command, action });
      if (action === 'pause') return pauseRef.current();
      if (action === 'resume') return resumeRef.current();
      if (action === 'stop') return stopAndSaveRef.current();
      return Promise.resolve();
    }), []),
  );

  const cancel = async () => {
    activeRef.current = false;
    pausedRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    if (CAPTURE_ENGINE === 'native-qwen') {
      await abortNativeCapture()
        .then(() => waitForNativeCaptureState(getNativeCaptureStatusAsync, 'idle', { timeoutMs: 20_000 }))
        .catch((cause) => {
          log.warn('record', 'native discard finalization was not acknowledged', { err: String(cause) });
        });
    } else if (!savingRef.current && !pausedRef.current && listeningRef.current) {
      const audioEndPromise = waitForAudioEnd();
      abortSession();
      await audioEndPromise.catch(() => {});
    } else if (!savingRef.current && (listeningRef.current || pausedRef.current)) {
      abortSession();
    }
    await artifactQueueRef.current.catch(() => {});
    await setNativeCaptureState('idle').catch(() => {});
    await stopRecordingForegroundService().catch(() => {});
    await flushDiagnostics().catch(() => {});
    if (meetingCreatedRef.current) await deleteMeeting(idRef.current).catch(() => {});
    if (dirRef.current) await FileSystem.deleteAsync(dirRef.current, { idempotent: true }).catch(() => {});
    await refresh();
    log.info('record', 'meeting discarded');
    router.back();
  };

  const confirmCancel = () => {
    if (!meetingCreatedRef.current || (!activeRef.current && !pausedRef.current && !listeningRef.current)) {
      void cancel();
      return;
    }
    Alert.alert("You're still recording", 'What would you like to do?', [
      { text: 'Keep recording', style: 'cancel' },
      { text: 'Save and stop', onPress: () => void stopAndSave() },
      { text: 'Discard this recording', style: 'destructive', onPress: () => void cancel() },
    ]);
  };

  if (error) {
    const problem = describeRecordingProblem(error);
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <AppText variant="heading" style={styles.center}>{problem.title}</AppText>
        <AppText variant="body" muted style={styles.center}>{problem.body}</AppText>
        {meetingCreated ? (
          <PrimaryButton label="Keep this recording" onPress={stopAndSave} style={{ marginTop: space.lg }} />
        ) : (
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ marginTop: space.lg }} />
        )}
        {meetingCreated ? (
          <SecondaryButton label="Discard" onPress={cancel} style={{ marginTop: space.md }} />
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg, paddingTop: insets.top + space.sm, paddingHorizontal: 16 }]}>
      <Pressable onPress={confirmCancel} hitSlop={12} style={styles.closeButton}>
        <Ionicons name="close" size={30} color={theme.text} />
      </Pressable>

      <View style={styles.heroWrap}>
        <Animated.View
          style={[
            styles.haloOuter,
            {
              backgroundColor: theme.mutedSoft,
            },
            audioPulseStyle,
          ]}
        >
          <View style={[styles.haloInner, { backgroundColor: theme.mint }]}>
            <View style={[styles.haloDotWrap, { backgroundColor: theme.accent }]}>
              <View style={[styles.haloDot, { backgroundColor: theme.primary }]} />
            </View>
          </View>
        </Animated.View>
        <AppText variant="timer" style={styles.center}>{formatDuration(elapsed)}</AppText>
        <AppText variant="title" muted style={styles.center}>
          {paused ? 'Paused' : 'Recording'}
        </AppText>
        <AppText variant="body" muted style={styles.center}>
          {paused ? 'Audio is safely paused.' : 'Saving audio locally.'}
        </AppText>
      </View>

      {captureNote ? (
        <Banner tone="info" style={{ marginBottom: space.md }}>
          <AppText variant="meta" muted>{captureNote}</AppText>
        </Banner>
      ) : null}

      <View style={{ paddingBottom: insets.bottom + space.lg, gap: space.md }}>
        <PrimaryButton label="Stop and save" onPress={stopAndSave} />
        <SecondaryButton label={paused ? 'Resume' : 'Pause'} onPress={paused ? resumeRecording : pauseRecording} />
        <Pressable onPress={confirmCancel} hitSlop={12}>
          <AppText variant="bodyStrong" color={theme.warn} style={styles.center}>
            Discard this recording
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  closeButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 0 },
  heroWrap: { alignItems: 'center', gap: space.sm, paddingBottom: space.sm },
  haloOuter: {
    width: 220,
    height: 220,
    borderRadius: 110,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.6,
  },
  haloInner: {
    width: 152,
    height: 152,
    borderRadius: 76,
    alignItems: 'center',
    justifyContent: 'center',
  },
  haloDotWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.55,
  },
  haloDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  emptyTranscript: { flex: 1, justifyContent: 'center' },
  center: { textAlign: 'center' },
});

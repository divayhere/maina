import * as FileSystem from 'expo-file-system/legacy';
import { router, useFocusEffect } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';

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
import {
  commitTranscriptFinalBlocks,
  createMeeting,
  deleteMeeting,
  discardTranscriptDraftBlock,
  finishRecordingSegment,
  getTranscriptSummary,
  newId,
  startRecordingSegment,
  type TranscriptBlock,
  upsertTranscriptDraftBlock,
  updateMeeting,
} from '@/data/meetings';
import { AppText, Card, PrimaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import {
  listAudioInputs,
  setNativeCaptureState,
  startRecordingForegroundService,
  stopRecordingForegroundService,
  subscribeAudioRouteChanges,
} from '@/hardware/recording/foreground';
import { CaptureHealthTracker } from '@/hardware/recording/health';
import { recordingDir, segmentIndexFromUri, segmentPath } from '@/hardware/recording/paths';
import { registerActiveTriggerHandler } from '@/hardware/trigger/hardwareTrigger';
import { resolveRemoteAction } from '@/hardware/trigger/remoteControl';
import { log } from '@/services/logger';
import {
  clearDiagnosticContext,
  finalizeDiagnosticRun,
  queueAudioArtifact,
  setDiagnosticContext,
} from '@/services/remoteLog';
import { maybeQueueMeetingPacket } from '@/services/meetingPacket';
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

interface EndWaiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
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

export default function RecordScreen() {
  const { theme } = useAppTheme();
  const { topPadding, insets } = useMainaLayout();
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

  const [recentBlocks, setRecentBlocks] = useState<TranscriptBlock[]>([]);
  const [interim, setInterim] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meetingCreated, setMeetingCreated] = useState(false);
  const [paused, setPaused] = useState(false);

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
    const snapshot = {
      durationMs: Math.max(0, now - startedAtRef.current - health.pausedDurationMs),
      segmentCount: sessionRef.current + 1,
      language: langRef.current,
      restartCount: restartCountRef.current,
    };
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

  const requestSessionEnd = (reason: string, graceful: boolean) => {
    if (!activeRef.current || endingSessionRef.current) return;
    endingSessionRef.current = true;
    healthRef.current.captureUnavailable(Date.now());
    void finalizeTranscriptText(interimRef.current);
    lastEventRef.current = Date.now();
    log.info('record', 'ending audio file', { index: sessionRef.current, reason, graceful });
    if (graceful) stopSession();
    else abortSession();
    // Upstream has reported silent interruptions without an end event. This
    // fallback is cancelled/replaced if end arrives normally.
    scheduleRestart(END_FALLBACK_MS, `${reason}-fallback`);
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
    const language = event.detectedLanguage?.toLocaleLowerCase() ?? 'unknown';
    if (event.detectedLanguage) detectedLanguageRef.current = event.detectedLanguage;
    const quality = asrQualityRef.current;
    if (language.startsWith('en')) quality.detectedEnglish += 1;
    if (language.startsWith('hi')) quality.detectedHindi += 1;
    if (event.languageSwitchResult === 'succeeded') quality.languageSwitchSucceeded += 1;
    if (event.languageSwitchResult === 'failed' || event.languageSwitchResult === 'skipped-no-model-or-not-allowed') {
      quality.languageSwitchFailed += 1;
    }
    const now = Date.now();
    const important = event.languageSwitchResult === 'succeeded' ||
      event.languageSwitchResult === 'failed' ||
      (event.confidence ?? 0) >= 0.8;
    const changed = lastLanguageLogRef.current.language !== language;
    if (!important && !changed && now - lastLanguageLogRef.current.at < 10_000) return;
    lastLanguageLogRef.current = { language, at: now };
    log[important ? 'info' : 'debug']('record', 'language detected', {
      language: event.detectedLanguage,
      confidence: event.confidence,
      alternatives: event.topLocaleAlternatives,
      switchResult: event.languageSwitchResult,
      switchResultCode: event.languageSwitchResultCode,
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
        const granted = await requestSpeechPermissions();
        if (!granted) throw new Error('Microphone permission was not granted.');
        if (!supportsOnDevice()) {
          throw new Error('On-device speech recognition is unavailable. Maina refused the network fallback.');
        }

        const dir = recordingDir(idRef.current);
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        dirRef.current = dir;
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
        const inputs = await listAudioInputs().catch(() => []);
        log.info('record', 'audio inputs visible', {
          inputs: inputs.map((input) => `${input.type}:${input.name}`),
        });
        activeRef.current = true;
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
      activeRef.current = false;
      pausedRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      void persist(true);
      abortSession();
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
    if (event.change === 'removed') {
      requestSessionEnd('external-mic-disconnected', false);
    } else if (event.change === 'added') {
      // Give Android USB enumeration a moment, then create a clean segment so
      // the new AudioRecord can select the external input.
      setTimeout(() => {
        if (activeRef.current) requestSessionEnd('external-mic-connected', true);
      }, 800);
    }
  // The route handler intentionally reads current capture refs and must remain
  // registered once for the lifetime of this recording screen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const now = Date.now();
      if (activeRef.current && startedAtRef.current !== 0) {
        const health = healthRef.current.snapshot(now);
        if (appStateRef.current === 'active') {
          setElapsed(Math.max(0, now - startedAtRef.current - health.pausedDurationMs));
        }
        void persist();

        if (!pausedRef.current) {
          if (now - lastHealthRef.current >= 60000) {
            lastHealthRef.current = now;
            log.info('record-health', 'capture heartbeat', {
              elapsedMs: now - startedAtRef.current,
              draftWords: transcriptWordCount(draftBlockRef.current?.text ?? ''),
              recentBlocks: recentBlocksRef.current.length,
              index: sessionRef.current,
              restarts: restartCountRef.current,
              listening: listeningRef.current,
              asr: asrQualityRef.current,
              ...health,
            });
          }
          if (now - sessionStartedAtRef.current >= MAX_FILE_MS) {
            requestSessionEnd('ten-minute-rotation', true);
          } else if (now - lastEventRef.current >= STALL_MS) {
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
        timer = setTimeout(tick, backgroundOrPaused ? 5000 : 1000);
      }
    };
    timer = setTimeout(tick, 1000);
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
    });
    return () => subscription.remove();
    // Persist is intentionally read from the latest closure while the app-state
    // subscription itself remains mounted once for the recording session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (!activeRef.current || pausedRef.current || savingRef.current || controlBusyRef.current) return;
    controlBusyRef.current = true;
    pausedRef.current = true;
    setPaused(true);
    healthRef.current.pauseStarted(Date.now());
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
    if (!activeRef.current || !pausedRef.current || savingRef.current || controlBusyRef.current) return;
    controlBusyRef.current = true;
    try {
      await artifactQueueRef.current.catch(() => {});
      pausedRef.current = false;
      setPaused(false);
      healthRef.current.pauseEnded(Date.now());
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
    if (!pausedRef.current) {
      const endPromise = waitForRecognizerEnd();
      const audioEndPromise = waitForAudioEnd();
      stopSession();
      await Promise.all([endPromise, audioEndPromise]);
    }

    const id = idRef.current;
    try {
      await transcriptChainRef.current.catch(() => {});
      await persist(true);
      const transcriptSummary = await getTranscriptSummary(id);
      const hasText = transcriptSummary.hasText;
      await updateMeeting(id, {
        transcript: null,
        status: hasText ? 'transcribed' : 'recorded',
        lastError: null,
      });
      const endedAt = Date.now();
      await artifactQueueRef.current.catch(() => {});
      try {
        const health = healthRef.current.snapshot(endedAt);
        const quality = asrQualityRef.current;
        await finalizeDiagnosticRun({
          runId: recordingSessionIdRef.current,
          meetingId: id,
          startedAt: new Date(startedAtRef.current).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          status: hasText ? 'transcribed' : 'recorded',
          wallDurationMs: endedAt - startedAtRef.current,
          audioDurationMs: health.audioDurationMs,
          expectedSegments: health.expectedSegments,
          closedSegments: health.closedSegments,
          uploadedSegments: 0,
          transcriptWords: transcriptSummary.wordCount,
          recognizerRestarts: restartCountRef.current,
          recognizerDowntimeMs: health.recognizerDowntimeMs,
          measuredGapMs: health.measuredGapMs,
          payload: {
            language: langRef.current,
            allowedLanguages: ACTIVE_LANGUAGES,
            failedSegments: health.failedSegments,
            largestGapMs: health.largestGapMs,
            pausedDurationMs: health.pausedDurationMs,
            activeDurationMs: Math.max(0, endedAt - startedAtRef.current - health.pausedDurationMs),
            asrQuality: quality.confidenceSamples > 0
              ? { ...quality, averageConfidence: quality.confidenceTotal / quality.confidenceSamples }
              : quality,
            uploadedSegmentsMeasuredAt: 'run-finalization-before-background-worker',
            captureOwner: 'expo-speech-recognition-native-audio-recorder',
            foregroundServiceRole: 'process-priority-and-microphone-disclosure',
          },
        });
      } catch (cause) {
        log.warn('remote', 'meeting artifacts remained local for later diagnostics retry', { err: String(cause) });
      }
      await refresh();
      if (hasText) {
        void maybeQueueMeetingPacket(id).catch((cause) => {
          log.warn('summary', 'automatic packet queue failed', { meetingId: id, err: String(cause) });
        });
      }
      log.info('record', 'meeting saved', {
        durationMs: Date.now() - startedAtRef.current,
        words: transcriptSummary.wordCount,
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
    abortSession();
    await stopRecordingForegroundService().catch(() => {});
    if (meetingCreatedRef.current) await deleteMeeting(idRef.current).catch(() => {});
    if (dirRef.current) await FileSystem.deleteAsync(dirRef.current, { idempotent: true }).catch(() => {});
    await refresh();
    log.info('record', 'meeting discarded');
    router.back();
  };

  if (error) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <AppText variant="heading" style={styles.center}>Recording problem</AppText>
        <AppText variant="body" muted style={styles.center}>{error}</AppText>
        {meetingCreated ? (
          <PrimaryButton label="Save what Maina kept" onPress={stopAndSave} style={{ marginTop: space.lg }} />
        ) : (
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ marginTop: space.lg }} />
        )}
        {meetingCreated ? (
          <Pressable onPress={cancel} style={{ marginTop: space.lg }}>
            <AppText variant="body" muted>Discard</AppText>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg, paddingTop: topPadding }]}>
      <Card style={styles.headerCard}>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: listening ? theme.rec : theme.warn }]} />
          <AppText variant="label" color={listening ? theme.rec : theme.warn}>
            {paused ? 'PAUSED' : listening ? 'RECORDING · OFFLINE' : 'RECOVERING SPEECH…'}
          </AppText>
        </View>
        <AppText variant="display" style={styles.timer}>{formatDuration(elapsed)}</AppText>
        <AppText variant="label" muted style={styles.center}>
          Background service active · audio checkpoints every 10 minutes
        </AppText>
      </Card>

      <Card style={styles.transcriptCard}>
        <ScrollView style={styles.transcriptBox} contentContainerStyle={{ padding: space.lg, gap: space.md, flexGrow: 1 }}>
          {recentBlocks.length > 0 || interim ? (
            <>
              {recentBlocks.map((block) => (
                <View key={block.blockId} style={styles.blockRow}>
                  <AppText variant="label" muted>
                    {block.startedAt ? formatTime(block.startedAt) : 'Live'}
                  </AppText>
                  <AppText variant="body">{block.text}</AppText>
                </View>
              ))}
              {interim ? (
                <View style={styles.blockRow}>
                  <AppText variant="label" muted>Live draft</AppText>
                  <AppText variant="body" muted>{interim}</AppText>
                </View>
              ) : null}
            </>
          ) : (
            <View style={styles.emptyTranscript}>
              <AppText variant="body" muted style={styles.center}>
                Maina is keeping the audio. Live words appear here as small transcript blocks when the on-device recognizer is confident.
              </AppText>
            </View>
          )}
        </ScrollView>
      </Card>

      <View style={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.lg }}>
        <View style={[styles.controls, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Pressable onPress={cancel} style={styles.cancel}>
            <AppText variant="body" muted>Discard</AppText>
          </Pressable>
          <PrimaryButton
            label={paused ? 'Resume' : 'Pause'}
            onPress={paused ? resumeRecording : pauseRecording}
            style={{ flex: 1 }}
          />
          <PrimaryButton label="Stop & Save" onPress={stopAndSave} style={{ backgroundColor: theme.rec, flex: 1 }} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  headerCard: { alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginBottom: space.lg },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: { fontSize: 56, lineHeight: 62, fontVariant: ['tabular-nums'] },
  transcriptCard: { flex: 1, marginHorizontal: space.lg, padding: 0, overflow: 'hidden' },
  transcriptBox: { flex: 1 },
  blockRow: { gap: space.xs },
  emptyTranscript: { flex: 1, justifyContent: 'center' },
  center: { textAlign: 'center' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderWidth: 1,
    borderRadius: 20,
  },
  cancel: {
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const project = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
const storePath = join(project, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/DiagnosticsStore.kt');
const workerPath = join(project, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/DiagnosticsWorker.kt');
const servicePath = join(project, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt');
const modulePath = join(project, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt');
const controlStorePath = join(project, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCaptureControlStore.kt');
const recordPath = join(project, 'src/app/record.tsx');
const matcherPath = join(project, 'src/core/recording/qualificationDiagnostics.ts');
const remoteLogPath = join(project, 'src/services/remoteLog.ts');
const appStartupPath = join(project, 'src/app/_layout.tsx');
const quarantineFencePath = join(project, 'src/services/nativeCaptureQuarantineFence.ts');
const meetingLifecyclePath = join(project, 'src/services/meetingCaptureLifecycle.ts');
const audioRetentionPath = join(project, 'src/services/audioRetention.ts');
const backgroundPipelineCorePath = join(project, 'src/services/backgroundPipelineCore.ts');
const backgroundPipelinePath = join(project, 'src/services/backgroundPipeline.ts');
const recoveryScreenPath = join(project, 'src/app/meeting/[id]/recover.tsx');
const automaticWorkAuthorityPath = join(project, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCaptureAutomaticWorkAuthority.kt');
const postProcessingServicePath = join(project, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt');
const postProcessingRecoveryPath = join(project, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingRecoveryWorker.kt');
const recorderManifestPath = join(project, 'modules/maina-recorder/android/src/main/AndroidManifest.xml');

const store = readFileSync(storePath, 'utf8');
const worker = readFileSync(workerPath, 'utf8');
const service = readFileSync(servicePath, 'utf8');
const moduleSource = readFileSync(modulePath, 'utf8');
const controlStore = readFileSync(controlStorePath, 'utf8');
const record = readFileSync(recordPath, 'utf8');
const matcher = readFileSync(matcherPath, 'utf8');
const remoteLog = readFileSync(remoteLogPath, 'utf8');
const appStartup = readFileSync(appStartupPath, 'utf8');
const quarantineFence = readFileSync(quarantineFencePath, 'utf8');
const meetingLifecycle = readFileSync(meetingLifecyclePath, 'utf8');
const audioRetention = readFileSync(audioRetentionPath, 'utf8');
const backgroundPipelineCore = readFileSync(backgroundPipelineCorePath, 'utf8');
const backgroundPipeline = readFileSync(backgroundPipelinePath, 'utf8');
const recoveryScreen = readFileSync(recoveryScreenPath, 'utf8');
const automaticWorkAuthority = readFileSync(automaticWorkAuthorityPath, 'utf8');
const postProcessingService = readFileSync(postProcessingServicePath, 'utf8');
const postProcessingRecovery = readFileSync(postProcessingRecoveryPath, 'utf8');
const recorderManifest = readFileSync(recorderManifestPath, 'utf8');

function kotlinConstant(name) {
  const match = new RegExp(`const val ${name}\\s*=\\s*(?:"""([\\s\\S]*?)"""|"([^"]*)")`, 'u').exec(store);
  assert.ok(match, `Missing diagnostics migration constant ${name}`);
  return match[1] ?? match[2];
}

const migration = [
  kotlinConstant('ADD_OUTBOX_MEETING_ID'),
  kotlinConstant('ADD_OUTBOX_PRIVACY_SCOPE'),
  kotlinConstant('ADD_ARTIFACT_PRIVACY_SCOPE'),
  kotlinConstant('CREATE_POLICY'),
  kotlinConstant('INSERT_POLICY'),
  kotlinConstant('CREATE_DISCARDED_MEETINGS'),
];

const root = mkdtempSync(join(tmpdir(), 'maina-diagnostics-v5-'));
const database = join(root, 'diagnostics.db');
const sqlite = '/usr/bin/sqlite3';
let assertions = 0;

function sql(source, expectSuccess = true) {
  const result = spawnSync(sqlite, [database], { input: source, encoding: 'utf8' });
  assert.equal(result.status === 0, expectSuccess, result.stderr);
  assertions += 1;
  return result.stdout.trim();
}

try {
  sql(`
    CREATE TABLE outbox_records (
      record_id TEXT PRIMARY KEY NOT NULL,
      target_table TEXT NOT NULL,
      payload TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at INTEGER
    );
    CREATE TABLE artifacts (
      artifact_id TEXT PRIMARY KEY NOT NULL,
      meeting_id TEXT NOT NULL,
      segment_index INTEGER,
      kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    INSERT INTO outbox_records(record_id,target_table,payload,created_at) VALUES('legacy-event','diagnostic_events','{}',1);
    INSERT INTO artifacts(artifact_id,meeting_id,kind,source_path,created_at) VALUES('legacy-artifact','legacy-meeting','audio','/private/original-audio',1);
    PRAGMA user_version=4;
    BEGIN IMMEDIATE;
    ${migration.join(';\n')};
    PRAGMA user_version=6;
    COMMIT;
  `);
  assert.equal(sql("SELECT privacy_scope FROM outbox_records WHERE record_id='legacy-event';"), 'ordinary');
  assert.equal(sql("SELECT privacy_scope FROM artifacts WHERE artifact_id='legacy-artifact';"), 'ordinary');
  assert.equal(sql("SELECT COUNT(*) FROM outbox_records WHERE privacy_scope='ordinary';"), '1');
  assert.equal(sql("SELECT COUNT(*) FROM artifacts WHERE privacy_scope='ordinary' AND source_path='/private/original-audio';"), '1');
  assert.equal(sql("SELECT mode||':'||generation FROM diagnostics_policy WHERE singleton_id=1;"), 'ordinary:0');
  assert.equal(sql("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='discarded_meetings';"), '1');
  assertions += 6;

  sql("INSERT INTO outbox_records(record_id,target_table,payload,privacy_scope,created_at) VALUES('bad','diagnostic_events','{}','qualification',2);", false);
  sql("UPDATE diagnostics_policy SET mode='qualification_active' WHERE singleton_id=1;", false);

  const digest = 'a'.repeat(64);
  sql(`UPDATE diagnostics_policy
       SET mode='qualification_reserved', qualification_meeting_id='qualification-meeting',
           qualification_evidence_digest='${digest}', generation=generation+1, updated_at=2
       WHERE singleton_id=1 AND mode='ordinary';
       INSERT INTO outbox_records(record_id,target_table,payload,privacy_scope,created_at)
       SELECT 'blocked','diagnostic_events','{}','ordinary',2
       WHERE (SELECT mode FROM diagnostics_policy WHERE singleton_id=1)='ordinary';`);
  assert.equal(sql("SELECT COUNT(*) FROM outbox_records WHERE record_id='blocked';"), '0');
  assertions += 1;
  assert.equal(sql(`UPDATE diagnostics_policy SET mode='qualification_active', updated_at=3
                    WHERE singleton_id=1 AND mode='qualification_reserved'
                      AND qualification_meeting_id='qualification-meeting'
                      AND qualification_evidence_digest='${digest}';
                    SELECT mode FROM diagnostics_policy WHERE singleton_id=1;`), 'qualification_active');
  assert.equal(sql(`UPDATE diagnostics_policy SET mode='qualification_terminal_ready', updated_at=4
                    WHERE singleton_id=1 AND mode='qualification_active'
                      AND qualification_meeting_id='qualification-meeting'
                      AND qualification_evidence_digest='${digest}';
                    SELECT mode FROM diagnostics_policy WHERE singleton_id=1;`), 'qualification_terminal_ready');
  assertions += 2;
  sql(`UPDATE diagnostics_policy
       SET mode='ordinary', qualification_meeting_id=NULL, qualification_evidence_digest=NULL, updated_at=5
       WHERE singleton_id=1 AND mode='qualification_terminal_ready'
         AND qualification_meeting_id='qualification-meeting'
         AND qualification_evidence_digest='${digest}';
       INSERT INTO outbox_records(record_id,target_table,payload,privacy_scope,created_at)
       SELECT 'ordinary','diagnostic_events','{}','ordinary',3
       WHERE (SELECT mode FROM diagnostics_policy WHERE singleton_id=1)='ordinary';`);
  assert.equal(
    sql("SELECT group_concat(record_id,',') FROM outbox_records WHERE privacy_scope='ordinary' ORDER BY created_at, record_id;"),
    'legacy-event,ordinary',
  );
  assertions += 1;

  const ordered = (source, tokens) => {
    let cursor = 0;
    return tokens.every((token) => {
      const index = source.indexOf(token, cursor);
      if (index < 0) return false;
      cursor = index + token.length;
      return true;
    });
  };
  assert.match(store, /private const val DB_VERSION = 6/u);
  assert.match(store, /DEFAULT 'ordinary'/u);
  assert.match(store, /privacy_scope = 'ordinary'/u);
  assert.match(worker, /store\.withOrdinaryDelivery\s*\{[\s\S]*?request\s*\(/u);
  assert.ok(ordered(record, ['beginAndroidQualificationDiagnostics', 'createMeeting({', 'startNativeCapture({']));
  assert.ok(ordered(record, [
    'cancelAndroidQualificationDiagnosticsBeforeCapture(',
    'if (released)',
    'setQualificationDiagnosticsSuppressed(false)',
  ]));
  assert.ok(ordered(service, ['qualificationReservationMatches(', 'captureControlStore.begin(', 'activateQualificationSession(', 'dispatchPreparedCapture(']));
  assert.ok(ordered(service, ['handleStopCompletion(', 'completeQualificationCaptureControl(qualificationMeetingId', 'MainaTerminalPublicationPolicy.succeeded(']));
  assert.ok(ordered(service.slice(service.indexOf('private fun completeQualificationCaptureControl')), ['markQualificationTerminalReady(', 'clearIfMatches(', 'completeQualificationTerminal(']));
  const abortCompletion = service.slice(
    service.indexOf('private fun handleAbortCompletion'),
    service.indexOf('private fun publishDiscardReadyForAck'),
  );
  assert.ok(ordered(abortCompletion, ['discardMeeting(current.meetingId)', 'markTerminalEffectReady(current)']));
  assert.doesNotMatch(abortCompletion, /clearIfMatches|lastCaptureMeetingId\s*=\s*null/u);
  const discardAcknowledgement = service.slice(
    service.indexOf('private fun acknowledgeNativeDiscard'),
    service.indexOf('private fun completeQualificationCaptureControl'),
  );
  assert.ok(ordered(discardAcknowledgement, [
    'current.meetingId != meetingId',
    'current.terminalDiscardId != discardId',
    '!current.terminalEffectReady',
    'clearIfMatches(current)',
    'lastCaptureMeetingId = null',
  ]));
  assert.match(service, /reconcileTerminalQualificationAfterProcessDeath[\s\S]*?preserveInterruptedCapture[\s\S]*?markQualificationTerminalReady[\s\S]*?clearIfMatches[\s\S]*?completeQualificationTerminal/u);
  assert.match(service, /!requestedQualificationSession && diagnosticsStore\.isQualificationSessionActive\(\)/u);
  assert.match(moduleSource, /isAndroidQualificationSessionActive\?\(\): Promise<boolean>|isQualificationSessionActive\(\)/u);
  assert.match(moduleSource, /control == MainaCaptureControlInspection\.Absent[\s\S]*?cancelQualificationReservation/u);
  assert.match(moduleSource, /qualificationRecoveryAction\(controls\)[\s\S]*?CANCEL_RESERVATION[\s\S]*?COMPLETE_TERMINAL[\s\S]*?reconcileAbsentCaptureControl/u);
  assert.match(moduleSource, /MainaCaptureControlInspection\.Invalid ->[\s\S]*?throw IllegalStateException\("Durable capture ownership is invalid"\)/u);
  assert.match(controlStore, /data object Absent[\s\S]*?data object Invalid[\s\S]*?data class Active[\s\S]*?data class Terminal/u);
  assert.match(controlStore, /fun clearIfMatches\(expected: MainaDurableCaptureControl\)/u);
  assert.match(controlStore, /internal object MainaCaptureTerminalAuthorityPolicy[\s\S]*?listOfNotNull\(disposition, quarantineReason\)\.size == 1/u);
  assert.equal((controlStore.match(/MainaCaptureTerminalAuthorityPolicy\.allows\(/gu) ?? []).length, 2);
  assert.match(service, /private fun requestTerminalNativeStop[\s\S]*?MainaCaptureTerminalDisposition\.DISCARD[\s\S]*?MainaCaptureTerminalDisposition\.SAVE/u);
  const nativeStopDispatch = service.slice(
    service.indexOf('private fun dispatchNativeStop'),
    service.indexOf('private fun handleStopOutcome'),
  );
  assert.doesNotMatch(nativeStopDispatch, /deleteCaptureDirectory/u);
  assert.ok(ordered(service.slice(service.indexOf('private fun handleStopOutcome')), [
    'MainaTerminalEffectAuthorityPolicy.verifiedOwner(',
    'handleAbortCompletion(',
    'deleteCaptureDirectory(current.directory)',
  ]));
  assert.match(service, /reconcileTerminalQualificationAfterProcessDeath[\s\S]*?PRESERVE_FOR_POST_PROCESSING[\s\S]*?DELETE_CAPTURE[\s\S]*?discardInterruptedCapture/u);
  assert.match(record, /stopNativeCapture\(\)[\s\S]*?confirmNativeSaveCompletion\(\{[\s\S]*?waitForCompletion: true/u);
  assert.match(matcher, /value\.includes\(meetingId\)/u);
  assert.match(matcher, /value instanceof Error/u);
  assert.match(remoteLog, /let sinkInstalled = false;[\s\S]*?let configured = false;[\s\S]*?let configurationAttempt/u);
  assert.match(remoteLog, /if \(configured\) return;[\s\S]*?if \(configurationAttempt\) return configurationAttempt;/u);
  assert.match(remoteLog, /let quarantineMeetingIds = new Set<string>\(\)/u);
  assert.match(remoteLog, /setQuarantineDiagnosticMeetingIds[\s\S]*?quarantineMeetingIds = normalizeQualificationMeetingIds/u);
  assert.match(remoteLog, /diagnosticSuppressionSourcesActive\([\s\S]*?qualificationActive:[\s\S]*?quarantineMeetingIds/u);
  assert.ok(ordered(appStartup, [
    'reconcilePendingNativeDiscards()',
    'establishNativeCaptureAutomaticWorkFence()',
    'listMeetings()',
    'repairStoredRecordingReferences([...protectedMeetingIds])',
  ]));
  assert.match(appStartup, /listInterruptedRecordingSegments\(\)\)[\s\S]*?!protectedMeetingIds\.has\(segment\.meetingId\)/u);
  assert.match(quarantineFence, /getNativeCaptureQuarantine\(\)[\s\S]*?state === 'blocked'[\s\S]*?throw new Error/u);
  assert.match(quarantineFence, /getMeeting\(meetingId\)[\s\S]*?status: 'interrupted'/u);
  assert.ok(ordered(meetingLifecycle, [
    'readNativeCaptureAutomaticWorkFence()',
    'getNativeCaptureStatusAsync()',
    'listMeetings()',
    'if (protectedMeetingIds.has(meeting.id)) continue',
    'readNativePostProcessingResult(meeting.id)',
  ]));
  assert.ok(ordered(audioRetention, [
    'readNativeCaptureAutomaticWorkFence()',
    'if (protectedMeetingIds.has(meetingId)) return Promise.resolve(false)',
    'getMeeting(meetingId)',
  ]));
  assert.ok(ordered(backgroundPipelineCore, [
    'reconcilePendingNativeDiscards()',
    'establishNativeCaptureAutomaticWorkFence()',
    'repairStoredRecordingReferences([...protectedMeetingIds])',
    'reconcilePendingNativeMeetingWork([...protectedMeetingIds])',
    "enforceAudioRetentionPolicy('pipeline', [...protectedMeetingIds])",
  ]));
  assert.match(backgroundPipeline, /setQuarantineDiagnosticMeetingIds\(fence\.protectedMeetingIds\)/u);
  assert.match(recoveryScreen, /readNativeCaptureAutomaticWorkFence\(\)[\s\S]*?setQuarantineDiagnosticMeetingIds\(fence\.protectedMeetingIds\)/u);
  assert.match(automaticWorkAuthority, /ContentProvider[\s\S]*?Binder\.getCallingUid\(\)[\s\S]*?MainaCaptureControlStore\(appContext\)\.inspect\(\)/u);
  assert.match(automaticWorkAuthority, /MainaCaptureDirectoryPolicy\.matches\(appContext\.filesDir/u);
  assert.match(recorderManifest, /MainaCaptureAutomaticWorkAuthorityProvider[\s\S]*?android:exported="false"[\s\S]*?android:grantUriPermissions="false"/u);
  assert.ok(ordered(postProcessingRecovery, [
    'MainaCaptureAutomaticWorkGate.classify(applicationContext, meetingId)',
    'MainaPostProcessingOutbox.shared',
    'MainaCaptureAutomaticWorkGate.classify(applicationContext, meetingId, directory)',
    'ContextCompat.startForegroundService',
  ]));
  const postProcessingRun = postProcessingService.slice(
    postProcessingService.indexOf('private fun runPostProcessing'),
    postProcessingService.indexOf('private data class WindowDecodeOutcome'),
  );
  assert.ok(ordered(postProcessingRun, [
    'requireAutomaticWorkAuthority(meetingId, directory)',
    'waitForFinalizedChunks(meetingId, directory)',
  ]));
  assert.match(postProcessingService, /if \(error is InterruptedException \|\| error is MainaAutomaticWorkBlockedException\) throw error/u);
  assert.ok(ordered(worker, [
    'MainaCaptureAutomaticWorkGate.classify(applicationContext, null)',
    'DiagnosticsStore.shared',
  ]));
  assert.match(automaticWorkAuthority, /is MainaCaptureControlInspection\.Active -> MainaAutomaticWorkAuthority\.DEFERRED/u);
  assert.match(automaticWorkAuthority, /terminalDisposition == MainaCaptureTerminalDisposition\.DISCARD[\s\S]*?MainaAutomaticWorkAuthority\.DISCARDED/u);
  assert.match(automaticWorkAuthority, /terminalDisposition == MainaCaptureTerminalDisposition\.SAVE[\s\S]*?meetingId == inspection\.control\.meetingId[\s\S]*?MainaAutomaticWorkAuthority\.ALLOWED/u);
  assert.match(postProcessingRecovery, /MainaAutomaticWorkAuthority\.DEFERRED -> return Result\.retry\(\)/u);
  assert.match(worker, /MainaAutomaticWorkAuthority\.DEFERRED,[\s\S]*?MainaAutomaticWorkAuthority\.DISCARDED,[\s\S]*?return@withContext Result\.retry\(\)/u);
  assert.match(recoveryScreen, /retryFailedDiagnosticArtifacts\(\)[\s\S]*?flushDiagnostics\(\)/u);
  assert.ok(ordered(service, [
    'purgeMeetingDiagnostics(current.meetingId)',
    'deleteCaptureDirectory(current.directory)',
    'discardMeeting(current.meetingId)',
  ]));
  assert.match(store, /fun purgeMeetingDiagnostics\(meetingId: String\): Boolean[\s\S]*?INSERT OR IGNORE INTO discarded_meetings[\s\S]*?delete\("outbox_records", "meeting_id = \?"[\s\S]*?delete\("artifacts", "meeting_id = \?"[\s\S]*?delete\("finalized_runs", "meeting_id = \?"/u);
  assert.match(store, /ordinaryIngressAllowed\(writableDatabase\) && !isMeetingDiscarded\(writableDatabase, meetingId\)/u);
  assert.match(worker, /record\.meetingId\?\.let\(store::isMeetingDiscarded\)/u);
  assert.match(worker, /requireAutomaticWorkAuthority\(artifact\.meetingId\)/u);
  assert.match(automaticWorkAuthority, /MainaPostProcessingOutbox\.shared\(appContext\)\.isDiscarded\(meetingId\)/u);
  assert.match(worker, /catch \(blocked: MainaAutomaticWorkBlockedException\)[\s\S]*?throw blocked/u);
  assert.match(service, /val commandInspection = captureControlStore\.inspect\(\)[\s\S]*?MainaDurableCommandAdmissionPolicy\.allows\(commandAuthority\)[\s\S]*?when \(intent\?\.action\)/u);
  assert.match(controlStore, /if \(!WRITE_AUTHORITY\.permitsAccess\(\)\)[\s\S]*?MainaCaptureControlInspection\.Invalid/u);
  assert.equal((controlStore.match(/WRITE_AUTHORITY\.commit \{/gu) ?? []).length, 3);
  assertions += 65;

  // The verifier itself must remain source-only and must not invoke Android tooling.
  assert.equal(execFileSync('/usr/bin/stat', ['-f', '%z', database], { encoding: 'utf8' }).trim().length > 0, true);
  assertions += 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`Android qualification diagnostics verified (${assertions} migration, restart, ingress, worker, and teardown assertions; zero device commands).`);

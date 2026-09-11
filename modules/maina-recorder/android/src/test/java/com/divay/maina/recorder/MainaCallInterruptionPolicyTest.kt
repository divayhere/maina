package com.divay.maina.recorder

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class MainaCallInterruptionPolicyTest {
    private fun source(relativePath: String): String {
        val workingDirectory = System.getProperty("user.dir") ?: error("user.dir is unavailable")
        val root = generateSequence(File(workingDirectory).absoluteFile) { it.parentFile }
            .map { File(it, relativePath) }
            .firstOrNull(File::isFile)
            ?: error("Could not locate source contract: $relativePath")
        return root.readText()
    }

    @Test
    fun `discard store CAS and capture directory ownership are exact`() {
        val filesDirectory = Files.createTempDirectory("maina-discard-root").toFile()
        try {
            val exact = File(filesDirectory, "rec-meeting-1")
            val other = File(filesDirectory, "rec-meeting-2")
            assertTrue(MainaCaptureDirectoryPolicy.matches(filesDirectory, "meeting-1", exact.path))
            assertTrue(MainaCaptureDirectoryPolicy.matches(filesDirectory, "meeting-1", exact.toURI().toString()))
            assertFalse(MainaCaptureDirectoryPolicy.matches(filesDirectory, "meeting-1", other.path))
            assertFalse(MainaCaptureDirectoryPolicy.matches(filesDirectory, "../meeting-1", exact.path))
            assertFalse(
                MainaCaptureDirectoryPolicy.matches(
                    filesDirectory,
                    "meeting-1",
                    requireNotNull(filesDirectory.parentFile).path,
                ),
            )

            val expected = MainaDurableCaptureControl(
                meetingId = "meeting-1",
                directory = exact.path,
                sourceMode = "voice_recognition",
                chunkDurationMs = 300_000L,
                meetingStartedAt = 1L,
                qualificationSession = false,
                qualificationEvidenceDigest = null,
                phase = MainaCaptureControlPhase.RECORDING,
                terminalDisposition = null,
                terminalDiscardId = null,
                terminalEffectReady = false,
                pauseOwner = MainaCapturePauseOwner.NONE,
                generation = 4L,
                communicationActive = false,
                chunkSequence = 0,
                captureGapMs = 0L,
                updatedAtEpochMs = 1L,
            )
            val prepared = expected.copy(
                phase = MainaCaptureControlPhase.TERMINAL,
                terminalDisposition = MainaCaptureTerminalDisposition.DISCARD,
                terminalDiscardId = "discard-1",
                generation = 5L,
            )
            assertTrue(MainaCaptureControlCasPolicy.allows(expected, expected))
            assertFalse(MainaCaptureControlCasPolicy.allows(prepared, expected))
        } finally {
            filesDirectory.deleteRecursively()
        }
    }

    @Test
    fun `legacy terminal ownership is quarantined without inferring save or discard`() {
        assertEquals(
            MainaCaptureQuarantineReason.LEGACY_TERMINAL_DISPOSITION_MISSING,
            MainaLegacyTerminalMigrationPolicy.quarantineReason(
                MainaCaptureControlStorageFormat.LEGACY_V1,
                MainaCaptureControlPhase.TERMINAL,
            ),
        )
        assertEquals(
            null,
            MainaLegacyTerminalMigrationPolicy.quarantineReason(
                MainaCaptureControlStorageFormat.LEGACY_V1,
                MainaCaptureControlPhase.RECORDING,
            ),
        )
        assertTrue(
            MainaCaptureTerminalAuthorityPolicy.allows(
                MainaCaptureControlPhase.TERMINAL,
                MainaCaptureTerminalDisposition.SAVE,
                null,
            ),
        )
        assertTrue(
            MainaCaptureTerminalAuthorityPolicy.allows(
                MainaCaptureControlPhase.TERMINAL,
                null,
                MainaCaptureQuarantineReason.LEGACY_TERMINAL_DISPOSITION_MISSING,
            ),
        )
        assertFalse(
            MainaCaptureTerminalAuthorityPolicy.allows(
                MainaCaptureControlPhase.TERMINAL,
                null,
                null,
            ),
        )
        assertFalse(
            MainaCaptureTerminalAuthorityPolicy.allows(
                MainaCaptureControlPhase.TERMINAL,
                MainaCaptureTerminalDisposition.DISCARD,
                MainaCaptureQuarantineReason.LEGACY_TERMINAL_DISPOSITION_MISSING,
            ),
        )
        assertTrue(
            MainaCaptureTerminalAuthorityPolicy.allows(
                MainaCaptureControlPhase.RECORDING,
                null,
                null,
            ),
        )
        assertFalse(
            MainaCaptureTerminalAuthorityPolicy.allows(
                MainaCaptureControlPhase.RECORDING,
                MainaCaptureTerminalDisposition.SAVE,
                null,
            ),
        )
        assertEquals(
            null,
            MainaLegacyTerminalMigrationPolicy.quarantineReason(
                MainaCaptureControlStorageFormat.CURRENT,
                MainaCaptureControlPhase.TERMINAL,
            ),
        )
    }

    @Test
    fun `failed capture control write poisons every same process retry`() {
        val authority = MainaCaptureWriteAuthority()
        var attempts = 0

        assertTrue(authority.permitsAccess())
        assertFalse(authority.commit {
            attempts += 1
            false
        })
        assertFalse(authority.permitsAccess())
        assertFalse(authority.commit {
            attempts += 1
            true
        })
        assertEquals(1, attempts)

        val thrown = MainaCaptureWriteAuthority()
        assertFalse(thrown.commit { error("disk result unavailable") })
        assertFalse(thrown.permitsAccess())
    }

    @Test
    fun `durable quarantine and uncertain writes reject every service command`() {
        assertTrue(
            MainaDurableCommandAdmissionPolicy.allows(MainaDurableCommandAuthority.AVAILABLE),
        )
        assertFalse(
            MainaDurableCommandAdmissionPolicy.allows(MainaDurableCommandAuthority.QUARANTINED),
        )
        assertFalse(
            MainaDurableCommandAdmissionPolicy.allows(MainaDurableCommandAuthority.INVALID),
        )

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val admission = service.substring(
            service.indexOf("val commandInspection = captureControlStore.inspect()"),
            service.indexOf("val notification = buildNotification()"),
        )
        assertTrue(admission.contains("MainaDurableCommandAdmissionPolicy.allows(commandAuthority)"))
        assertTrue(admission.contains("publishQuarantinedCapture(commandInspection.control)"))
        assertTrue(admission.contains("publishInvalidDurableCapture()"))
        assertTrue(admission.indexOf("when (intent?.action)") > admission.indexOf("MainaDurableCommandAdmissionPolicy.allows"))
    }

    @Test
    fun `automatic native work is fenced by invalid or quarantined main process authority`() {
        val control = MainaDurableCaptureControl(
            meetingId = "meeting-1",
            directory = "/data/user/0/com.divay.maina/files/rec-meeting-1",
            sourceMode = "voice_recognition",
            chunkDurationMs = 300_000L,
            meetingStartedAt = 1L,
            qualificationSession = false,
            qualificationEvidenceDigest = null,
            phase = MainaCaptureControlPhase.TERMINAL,
            terminalDisposition = null,
            terminalDiscardId = null,
            terminalEffectReady = false,
            pauseOwner = MainaCapturePauseOwner.NONE,
            generation = 4L,
            communicationActive = false,
            chunkSequence = 0,
            captureGapMs = 0L,
            updatedAtEpochMs = 1L,
            sourceFormatVersion = 1,
            quarantineReason = MainaCaptureQuarantineReason.LEGACY_TERMINAL_DISPOSITION_MISSING,
        )
        assertEquals(
            MainaAutomaticWorkAuthority.ALLOWED,
            MainaAutomaticWorkAdmissionPolicy.classify(MainaCaptureControlInspection.Absent, "meeting-1"),
        )
        assertEquals(
            MainaAutomaticWorkAuthority.INVALID,
            MainaAutomaticWorkAdmissionPolicy.classify(MainaCaptureControlInspection.Invalid, "meeting-1"),
        )
        assertEquals(
            MainaAutomaticWorkAuthority.INVALID,
            MainaAutomaticWorkAdmissionPolicy.classify(MainaCaptureControlInspection.Absent, "../meeting-1"),
        )
        assertEquals(
            MainaAutomaticWorkAuthority.QUARANTINED,
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlInspection.Quarantined(control),
                "unrelated-meeting",
            ),
        )
        assertEquals(
            MainaAutomaticWorkAuthority.QUARANTINED,
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlInspection.Quarantined(control),
                null,
            ),
        )
        val active = control.copy(
            phase = MainaCaptureControlPhase.RECORDING,
            terminalDisposition = null,
            quarantineReason = null,
        )
        assertEquals(
            MainaAutomaticWorkAuthority.DEFERRED,
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlInspection.Active(active),
                "meeting-1",
            ),
        )
        val terminalSave = control.copy(
            terminalDisposition = MainaCaptureTerminalDisposition.SAVE,
            quarantineReason = null,
        )
        assertEquals(
            MainaAutomaticWorkAuthority.ALLOWED,
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlInspection.Terminal(terminalSave),
                "meeting-1",
            ),
        )
        assertEquals(
            MainaAutomaticWorkAuthority.DEFERRED,
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlInspection.Terminal(terminalSave),
                null,
            ),
        )
        val terminalDiscard = control.copy(
            terminalDisposition = MainaCaptureTerminalDisposition.DISCARD,
            terminalDiscardId = "discard-1",
            quarantineReason = null,
        )
        assertEquals(
            MainaAutomaticWorkAuthority.DISCARDED,
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlInspection.Terminal(terminalDiscard),
                "meeting-1",
            ),
        )
        assertEquals(
            MainaAutomaticWorkAuthority.DISCARDED,
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlInspection.Terminal(terminalDiscard),
                null,
            ),
        )
        assertEquals(
            MainaAutomaticWorkAuthority.DEFERRED,
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlInspection.Terminal(terminalDiscard),
                "unrelated-meeting",
            ),
        )

        val authoritySource = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCaptureAutomaticWorkAuthority.kt",
        )
        val manifest = source("modules/maina-recorder/android/src/main/AndroidManifest.xml")
        val recoveryWorker = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingRecoveryWorker.kt",
        )
        val postProcessing = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt",
        )
        val diagnostics = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/DiagnosticsWorker.kt",
        )
        val diagnosticsStore = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/DiagnosticsStore.kt",
        )
        val postProcessingOutbox = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingOutbox.kt",
        )
        assertTrue(authoritySource.contains("Binder.getCallingUid() != appContext.applicationInfo.uid"))
        assertTrue(authoritySource.contains("MainaCaptureControlStore(appContext).inspect()"))
        assertTrue(authoritySource.contains("context.applicationContext.contentResolver.call"))
        assertTrue(manifest.contains("android:exported=\"false\""))
        assertTrue(manifest.contains("android:grantUriPermissions=\"false\""))
        val recoveryRun = recoveryWorker.substring(recoveryWorker.indexOf("override suspend fun doWork"))
        assertTrue(
            recoveryRun.indexOf("MainaCaptureAutomaticWorkGate.classify") <
                recoveryRun.indexOf("MainaPostProcessingOutbox.shared"),
        )
        val runPostProcessing = postProcessing.substring(
            postProcessing.indexOf("private fun runPostProcessing"),
            postProcessing.indexOf("private data class WindowDecodeOutcome"),
        )
        assertTrue(
            runPostProcessing.indexOf("requireAutomaticWorkAuthority(meetingId, directory)") <
                runPostProcessing.indexOf("waitForFinalizedChunks(meetingId, directory)"),
        )
        assertTrue(
            diagnostics.indexOf("MainaCaptureAutomaticWorkGate.classify") <
                diagnostics.indexOf("DiagnosticsStore.shared"),
        )
        assertTrue(diagnostics.contains("MainaAutomaticWorkAuthority.DEFERRED"))
        assertTrue(recoveryRun.contains("MainaAutomaticWorkAuthority.DEFERRED -> return Result.retry()"))
        assertTrue(postProcessingOutbox.contains("DB_VERSION = 7"))
        assertTrue(postProcessingOutbox.contains("check(!isDiscarded(writableDatabase, meetingId))"))
        assertTrue(postProcessingOutbox.contains("INSERT OR IGNORE INTO discarded_meetings"))
        assertTrue(diagnosticsStore.contains("DB_VERSION = 6"))
        assertTrue(diagnosticsStore.contains("ordinaryIngressAllowed(writableDatabase) && !isMeetingDiscarded"))
        assertTrue(diagnostics.contains("record.meetingId?.let(store::isMeetingDiscarded)"))
        assertTrue(diagnostics.contains("requireAutomaticWorkAuthority(artifact.meetingId)"))
    }

    @Test
    fun `terminal effects require a fresh exact durable owner after native stop`() {
        val operation = MainaCaptureOperationToken(
            operationId = 77L,
            generation = 9L,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.STOP,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
            captureSessionId = "meeting-1",
        )
        val owner = MainaDurableCaptureControl(
            meetingId = "meeting-1",
            directory = "/data/user/0/com.divay.maina/files/rec-meeting-1",
            sourceMode = "voice_recognition",
            chunkDurationMs = 300_000L,
            meetingStartedAt = 1L,
            qualificationSession = false,
            qualificationEvidenceDigest = null,
            phase = MainaCaptureControlPhase.TERMINAL,
            terminalDisposition = MainaCaptureTerminalDisposition.SAVE,
            terminalDiscardId = null,
            terminalEffectReady = false,
            pauseOwner = MainaCapturePauseOwner.NONE,
            generation = 9L,
            communicationActive = false,
            chunkSequence = 1,
            captureGapMs = 0L,
            updatedAtEpochMs = 2L,
        )
        assertEquals(
            owner,
            MainaTerminalEffectAuthorityPolicy.verifiedOwner(
                MainaCaptureControlInspection.Terminal(owner),
                owner,
                operation,
                MainaCaptureTerminalDisposition.SAVE,
                "meeting-1",
            ),
        )
        assertEquals(
            null,
            MainaTerminalEffectAuthorityPolicy.verifiedOwner(
                MainaCaptureControlInspection.Invalid,
                owner,
                operation,
                MainaCaptureTerminalDisposition.SAVE,
                "meeting-1",
            ),
        )
        assertEquals(
            null,
            MainaTerminalEffectAuthorityPolicy.verifiedOwner(
                MainaCaptureControlInspection.Terminal(owner.copy(generation = 10L)),
                owner,
                operation,
                MainaCaptureTerminalDisposition.SAVE,
                "meeting-1",
            ),
        )
        assertEquals(
            null,
            MainaTerminalEffectAuthorityPolicy.verifiedOwner(
                MainaCaptureControlInspection.Terminal(owner),
                owner,
                operation,
                MainaCaptureTerminalDisposition.SAVE,
                "meeting-2",
            ),
        )
        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val dispatch = service.substring(
            service.indexOf("private fun dispatchNativeStop"),
            service.indexOf("private fun handleStopOutcome"),
        )
        val completion = service.substring(
            service.indexOf("private fun handleStopOutcome"),
            service.indexOf("private fun publishDiscardReadyForAck"),
        )
        assertFalse(dispatch.contains("deleteCaptureDirectory"))
        assertTrue(completion.contains("MainaTerminalEffectAuthorityPolicy.verifiedOwner"))
        assertTrue(
            completion.indexOf("MainaTerminalEffectAuthorityPolicy.verifiedOwner") <
                completion.indexOf("handleStopCompletion("),
        )
        assertTrue(
            completion.indexOf("MainaTerminalEffectAuthorityPolicy.verifiedOwner") <
                completion.indexOf("deleteCaptureDirectory"),
        )
        assertTrue(
            completion.indexOf("purgeMeetingDiagnostics(current.meetingId)") <
                completion.indexOf("deleteCaptureDirectory(current.directory)"),
        )
    }

    @Test
    fun `terminal store and publication handoff source contracts stay fail closed`() {
        val store = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCaptureControlStore.kt",
        )
        assertTrue(
            store.contains(
                "data class Terminal(val control: MainaDurableCaptureControl)",
            ),
        )
        assertTrue(store.contains("data class Quarantined(val control: MainaDurableCaptureControl)"))
        assertTrue(store.contains("MainaCaptureControlInspection.Terminal(value)"))
        assertTrue(store.contains("data object Absent"))
        assertTrue(store.contains("data object Invalid"))
        assertTrue(store.contains("val terminalDisposition: MainaCaptureTerminalDisposition?"))
        assertTrue(store.contains("MainaCaptureTerminalAuthorityPolicy.allows"))
        val activeRead = store.substring(
            store.indexOf("fun read():"),
            store.indexOf("fun readIncludingTerminal():"),
        )
        val recoveryRead = store.substring(
            store.indexOf("fun readIncludingTerminal():"),
            store.indexOf("fun begin("),
        )
        assertFalse(activeRead.contains("MainaCaptureControlInspection.Terminal"))
        assertTrue(recoveryRead.contains("MainaCaptureControlInspection.Terminal"))
        assertTrue(recoveryRead.contains("MainaCaptureControlInspection.Quarantined"))

        val legacyStored = mapOf<String, Any>(
            "meeting_id" to "meeting-1",
            "directory" to "/private/capture",
            "source_mode" to "voice_recognition",
            "chunk_duration_ms" to 300_000L,
            "meeting_started_at" to 1L,
            "phase" to "RECORDING",
            "pause_owner" to "NONE",
            "generation" to 1L,
            "communication_active" to false,
            "chunk_sequence" to 0,
            "capture_gap_ms" to 0L,
            "updated_at" to 1L,
        )
        assertEquals(
            MainaCaptureControlStorageFormat.LEGACY_V1,
            MainaCaptureControlStoragePolicy.classify(legacyStored),
        )
        val currentStored = legacyStored + ("qualification_session" to false)
        assertEquals(
            MainaCaptureControlStorageFormat.CURRENT,
            MainaCaptureControlStoragePolicy.classify(currentStored),
        )
        assertEquals(
            MainaCaptureControlStorageFormat.CURRENT,
            MainaCaptureControlStoragePolicy.classify(
                currentStored + mapOf(
                    "qualification_evidence_digest" to "a".repeat(64),
                    "terminal_disposition" to "SAVE",
                    "terminal_effect_ready" to true,
                ),
            ),
        )
        assertEquals(
            MainaCaptureControlStorageFormat.CURRENT,
            MainaCaptureControlStoragePolicy.classify(
                currentStored + mapOf(
                    "phase" to "TERMINAL",
                    "source_format_version" to 1,
                    "quarantine_reason" to "LEGACY_TERMINAL_DISPOSITION_MISSING",
                ),
            ),
        )
        assertEquals(
            MainaCaptureControlStorageFormat.CURRENT,
            MainaCaptureControlStoragePolicy.classify(
                currentStored + mapOf(
                    "phase" to "TERMINAL",
                    "terminal_disposition" to "DISCARD",
                    "terminal_discard_id" to "discard-1",
                    "terminal_effect_ready" to false,
                ),
            ),
        )
        assertEquals(
            MainaCaptureControlStorageFormat.INVALID,
            MainaCaptureControlStoragePolicy.classify(legacyStored + ("unexpected" to true)),
        )
        assertEquals(
            MainaCaptureControlStorageFormat.INVALID,
            MainaCaptureControlStoragePolicy.classify(legacyStored + ("chunk_sequence" to 0L)),
        )
        assertEquals(
            MainaCaptureControlStorageFormat.INVALID,
            MainaCaptureControlStoragePolicy.classify(currentStored + ("qualification_session" to "false")),
        )
        assertEquals(
            MainaCaptureControlStorageFormat.INVALID,
            MainaCaptureControlStoragePolicy.classify(currentStored + ("terminal_effect_ready" to "true")),
        )
        assertTrue(store.contains("storageFormat == MainaCaptureControlStorageFormat.LEGACY_V1"))
        assertTrue(store.contains("if (!persist(value))"))
        assertTrue(store.contains("if (!WRITE_AUTHORITY.permitsAccess())"))
        assertTrue(store.contains("WRITE_AUTHORITY.commit { editor.commit() }"))
        assertTrue(store.contains("WRITE_AUTHORITY.commit { prefs.edit().clear().commit() }"))
        assertFalse(store.contains("prefs.getString(KEY_MEETING_ID"))
        assertTrue(store.contains("stored[KEY_MEETING_ID] as? String"))
        assertTrue(store.contains("stored[KEY_CHUNK_SEQUENCE] as? Int"))
        val discardPrepare = store.substring(
            store.indexOf("fun prepareDiscard("),
            store.indexOf("fun captureDirectoryMatchesMeeting"),
        )
        assertTrue(discardPrepare.indexOf("latchReadsOff()") < discardPrepare.indexOf("persist(prepared)"))
        assertTrue(discardPrepare.contains("captureDirectoryMatchesMeeting"))
        assertTrue(discardPrepare.contains("MainaCaptureControlInspection.Quarantined"))
        assertTrue(store.contains("fun recoverQuarantinedAsSave"))
        assertTrue(store.contains("if (persist(resolved)) resolved else null"))
        val storeUpdate = store.substring(store.indexOf("fun update("), store.indexOf("fun clear():"))
        assertTrue(storeUpdate.contains("MainaCaptureControlCasPolicy.allows(observed, current)"))
        val storeBegin = store.substring(store.indexOf("fun begin("), store.indexOf("fun update("))
        assertTrue(storeBegin.contains("inspectUnlocked() != MainaCaptureControlInspection.Absent"))

        val terminalService = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val recorderModule = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt",
        )
        assertTrue(recorderModule.contains("EXTRA_CAPTURE_GENERATION to recovered.generation.toString()"))
        val terminalRequest = terminalService.substring(
            terminalService.indexOf("private fun requestTerminalNativeStop"),
            terminalService.indexOf("private fun accepts("),
        )
        assertTrue(terminalRequest.contains("MainaCaptureTerminalDisposition.DISCARD"))
        assertTrue(terminalRequest.contains("MainaCaptureTerminalDisposition.SAVE"))
        assertTrue(terminalService.contains("requestedTerminalState = prepared.reducerState()"))
        assertTrue(terminalRequest.contains("preparedDiscardMayRun"))
        val terminalRecovery = terminalService.substring(
            terminalService.indexOf("private fun reconcileTerminalQualificationAfterProcessDeath"),
            terminalService.indexOf("private fun emitServiceHeartbeat"),
        )
        assertTrue(terminalRecovery.contains("MainaTerminalRestartAction.PRESERVE_FOR_POST_PROCESSING"))
        assertTrue(terminalRecovery.contains("MainaTerminalRestartAction.DELETE_CAPTURE"))
        assertTrue(terminalRecovery.contains("discardInterruptedCapture(restored)"))
        assertTrue(terminalService.contains("latchReadsOffForPreparedDiscardIfRunning"))
        val quarantineRestore = terminalService.substring(
            terminalService.indexOf("if (inspection is MainaCaptureControlInspection.Quarantined)"),
            terminalService.indexOf("if (inspection is MainaCaptureControlInspection.Terminal)"),
        )
        assertTrue(quarantineRestore.contains("publishQuarantinedCapture(inspection.control)"))
        val quarantinePublication = terminalService.substring(
            terminalService.indexOf("private fun publishQuarantinedCapture"),
            terminalService.indexOf("private fun restoreDurableCaptureControl"),
        )
        assertTrue(quarantinePublication.contains("legacy_terminal_disposition_missing"))
        assertFalse(quarantinePublication.contains("preserveInterruptedCapture"))
        assertFalse(quarantinePublication.contains("discardInterruptedCapture"))
        val quarantineAction = terminalService.substring(
            terminalService.indexOf("ACTION_RECONCILE_QUARANTINED_CAPTURE ->"),
            terminalService.indexOf("ACTION_RETRY_TERMINAL_NATIVE_CAPTURE ->"),
        )
        assertTrue(quarantineAction.contains("terminal != null"))
        assertTrue(quarantineAction.contains("terminal.meetingId == meetingId"))
        assertTrue(quarantineAction.contains("terminal.generation == generation"))
        assertTrue(quarantineAction.contains("terminal.terminalDisposition == MainaCaptureTerminalDisposition.SAVE"))
        val discardAck = terminalService.substring(
            terminalService.indexOf("private fun acknowledgeNativeDiscard"),
            terminalService.indexOf("private fun completeQualificationCaptureControl"),
        )
        val absentAcknowledgement = discardAck.substring(
            discardAck.indexOf("MainaCaptureControlInspection.Absent"),
            discardAck.indexOf("MainaCaptureControlInspection.Invalid"),
        )
        assertFalse(absentAcknowledgement.contains("publishTerminalRecoveryRequired"))

        assertEquals(
            MainaCaptureTerminalDisposition.DISCARD,
            MainaCaptureTerminalRecoveryPolicy.dispositionForLifecycleInvalidation(
                MainaCaptureControlPhase.TERMINAL,
                MainaCaptureTerminalDisposition.DISCARD,
            ),
        )
        assertEquals(
            MainaCaptureTerminalDisposition.SAVE,
            MainaCaptureTerminalRecoveryPolicy.dispositionForLifecycleInvalidation(
                MainaCaptureControlPhase.TERMINAL,
                MainaCaptureTerminalDisposition.SAVE,
            ),
        )
        assertEquals(
            MainaCaptureTerminalDisposition.SAVE,
            MainaCaptureTerminalRecoveryPolicy.dispositionForLifecycleInvalidation(
                MainaCaptureControlPhase.RECORDING,
                null,
            ),
        )
        assertEquals(
            MainaCaptureTerminalDisposition.DISCARD,
            MainaCaptureTerminalRecoveryPolicy.dispositionForLifecycleInvalidation(
                MainaCaptureControlPhase.RECORDING,
                MainaCaptureTerminalDisposition.DISCARD,
            ),
        )
        assertEquals(
            null,
            MainaCaptureTerminalRecoveryPolicy.dispositionForLifecycleInvalidation(
                MainaCaptureControlPhase.TERMINAL,
                null,
            ),
        )
        val destroy = terminalService.substring(
            terminalService.indexOf("override fun onDestroy()"),
            terminalService.indexOf("override fun onBind"),
        )
        val invalidation = terminalService.substring(
            terminalService.indexOf("private fun invalidateCaptureControl"),
            terminalService.indexOf("private fun restoreDurableCaptureControl"),
        )
        assertTrue(destroy.contains("invalidateCaptureControl(\"service-destroyed\")"))
        assertTrue(invalidation.contains("dispositionForLifecycleInvalidation"))
        assertTrue(invalidation.contains("durableControl?.terminalDisposition != null"))
        assertFalse(invalidation.contains("event,\n            MainaCaptureTerminalDisposition.SAVE"))

        val recoveryScreen = source("src/app/meeting/[id]/recover.tsx")
        assertTrue(recoveryScreen.contains("Recover saved audio"))
        assertTrue(recoveryScreen.contains("Discard this recording"))
        assertTrue(recoveryScreen.contains("recoverNativeCaptureQuarantine"))
        assertTrue(recoveryScreen.contains("discardNativeMeeting"))

        val stopAndSave = source("src/app/record.tsx").substring(
            source("src/app/record.tsx").indexOf("const stopAndSave = async"),
            source("src/app/record.tsx").indexOf("useEffect(() => {\n    stopAndSaveRef.current"),
        )
        val nativeStopFailure = stopAndSave.indexOf("native capture stop request failed")
        val nativeStopFailureReturn = stopAndSave.indexOf("return;", nativeStopFailure)
        assertTrue(nativeStopFailure >= 0)
        assertTrue(nativeStopFailureReturn > nativeStopFailure)
        assertTrue(
            nativeStopFailureReturn < stopAndSave.indexOf("const id = idRef.current"),
        )
        val statusOnlyRecovery = stopAndSave.substring(
            stopAndSave.indexOf("if (entryAction !== 'begin_stop')"),
            stopAndSave.indexOf("} else {", stopAndSave.indexOf("if (entryAction !== 'begin_stop')")),
        )
        assertTrue(statusOnlyRecovery.contains("confirmNativeSaveCompletion"))
        assertFalse(statusOnlyRecovery.contains("stopNativeCapture()"))
        assertTrue(source("src/app/record.tsx").contains("retryNativeCaptureFinalization()"))

        val native = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt",
        )
        val preparation = native.substring(
            native.indexOf("fun prepareRecordingOwnershipPublication"),
            native.indexOf("fun enablePreparedReads"),
        )
        val enable = native.substring(
            native.indexOf("fun enablePreparedReads"),
            native.indexOf("fun stop(): Snapshot"),
        )
        assertFalse(preparation.contains("readEnabled.set(true)"))
        assertTrue(enable.contains("readEnabled.set(true)"))
        assertFalse(enable.contains("appendJournal("))
        assertFalse(enable.contains("onEvent("))
        assertFalse(enable.contains("publishStatus("))

        val blockingRead = native.indexOf("val read = recorder?.read")
        val commitBarrier = native.indexOf("readCommitBarrier.commitIf", blockingRead)
        val postReadSafety = native.indexOf("MainaNativeReadSafetyPolicy.shouldPersistRead", blockingRead)
        val firstWrite = native.indexOf("chunkForCommit.output.write", blockingRead)
        assertTrue(blockingRead >= 0)
        assertTrue(commitBarrier > blockingRead)
        assertTrue(postReadSafety > commitBarrier)
        assertTrue(firstWrite > postReadSafety)
        val latchMethod = native.substring(
            native.indexOf("fun latchReadsOffNow"),
            native.indexOf("fun pause(): Snapshot"),
        )
        assertTrue(latchMethod.indexOf("synchronized(recorderLock)") < latchMethod.indexOf("readCommitBarrier.latch"))
        assertTrue(latchMethod.contains("readCommitBarrier.latch"))
        assertTrue(latchMethod.contains("privacyLatchGeneration.incrementAndGet()"))

        val nativeStart = native.substring(
            native.indexOf("fun start(options: Options, expectedLatchGeneration: Long)"),
            native.indexOf("fun restorePausedSession"),
        )
        val nativeResume = native.substring(
            native.indexOf("fun resume(expectedLatchGeneration: Long)"),
            native.indexOf("fun prepareRecordingOwnershipPublication"),
        )
        assertFalse(nativeStart.contains("val expectedLatchGeneration = privacyLatchGeneration.get()"))
        assertFalse(nativeResume.contains("val expectedLatchGeneration = privacyLatchGeneration.get()"))

        val recorderStart = native.substring(
            native.indexOf("private fun createAndStartRecorder"),
            native.indexOf("private fun releaseRecorder"),
        )
        assertTrue(recorderStart.indexOf("synchronized(recorderLock)") < recorderStart.indexOf("privacyLatchGeneration.get()"))
        assertTrue(recorderStart.indexOf("privacyLatchGeneration.get()") < recorderStart.indexOf("created.startRecording()"))

        val pauseMethod = native.substring(
            native.indexOf("fun pause(): Snapshot"),
            native.indexOf("fun resume(expectedLatchGeneration: Long): Snapshot"),
        )
        assertFalse(pauseMethod.contains("paused.get() && recorder == null"))
        assertTrue(pauseMethod.contains("MainaNativePauseCheckpointPolicy.requiresCheckpoint"))
        assertTrue(pauseMethod.contains("workerPresent = worker != null"))
        assertTrue(pauseMethod.contains("preparedChunkPresent = hasPreparedChunk"))
        assertTrue(pauseMethod.contains("pauseCheckpointLatch = checkpoint"))
        assertTrue(pauseMethod.indexOf("pauseCheckpointLatch = checkpoint") < pauseMethod.indexOf("latchReadsOffNow()"))
        assertTrue(pauseMethod.contains("checkpoint.await(PAUSE_CHECKPOINT_TIMEOUT_MS"))

        val recovery = native.substring(
            native.indexOf("private fun recoverRecorder"),
            native.indexOf("private fun publishStatusIfDue"),
        )
        assertTrue(Regex("MainaNativeRecorderOwnershipPolicy\\.recoveryMayProceed").findAll(recovery).count() >= 3)
        assertTrue(recovery.indexOf("Thread.sleep(") < recovery.indexOf("recoveryMayProceed", recovery.indexOf("Thread.sleep(")))
        assertTrue(recovery.indexOf("recoveryMayProceed", recovery.indexOf("Thread.sleep(")) < recovery.indexOf("val candidate = openChunk"))
        val capturedGeneration = recovery.indexOf("val expectedLatchGeneration = privacyLatchGeneration.get()")
        val finalStateCheck = recovery.indexOf("recoveryMayProceed", capturedGeneration)
        assertTrue(capturedGeneration > recovery.indexOf("Thread.sleep("))
        assertTrue(finalStateCheck > capturedGeneration)
        assertTrue(finalStateCheck < recovery.indexOf("createAndStartRecorder("))
        assertTrue(recovery.indexOf("ownershipMayBeReturned") > recovery.indexOf("createAndStartRecorder("))

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val startAction = service.substring(
            service.indexOf("ACTION_START_NATIVE_CAPTURE ->"),
            service.indexOf("ACTION_PAUSE_NATIVE_CAPTURE ->"),
        )
        assertTrue(startAction.indexOf("startAdmissionAllowed(") < startAction.indexOf("lastCaptureMeetingId = meetingId"))
        assertTrue(startAction.indexOf("startAdmissionAllowed(") < startAction.indexOf("captureControlStore.begin("))
        val issueOperation = service.substring(
            service.indexOf("private fun issueCaptureOperation"),
            service.indexOf("private fun invalidateActiveOperation"),
        )
        assertTrue(issueOperation.contains("expectedPrivacyLatchGeneration"))
        assertTrue(issueOperation.contains("nativeCapture.privacyGenerationSnapshot()"))
        assertTrue(issueOperation.contains("MainaCaptureOperationKind.PAUSE"))
        val preparedDispatch = service.substring(
            service.indexOf("private fun dispatchPreparedCapture"),
            service.indexOf("private fun handlePreparedCaptureOutcome"),
        )
        assertTrue(preparedDispatch.indexOf("nativePreparationAllowed(") < preparedDispatch.indexOf("runCatching(nativeOperation)"))
        assertTrue(preparedDispatch.contains("currentPrivacyLatchGeneration = nativeCapture.privacyGenerationSnapshot()"))
        assertTrue(preparedDispatch.contains("communicationActive = observedCommunicationActive()"))
        val resumeCleanupStart = service.indexOf(
            "if (MainaCaptureOperationPolicy.preparationFailureNeedsPause",
        )
        val preparedFailure = service.substring(
            resumeCleanupStart,
            service.indexOf("} else {", resumeCleanupStart),
        )
        assertTrue(preparedFailure.contains("pausePreparedCapture("))
        assertFalse(preparedFailure.contains("rollbackPreparedCapture("))
        assertFalse(preparedFailure.contains("queueNativePauseWithoutReducer("))

        val pauseOutcome = service.substring(
            service.indexOf("private fun handlePauseOutcome"),
            service.indexOf("private fun queueNativePauseWithoutReducer"),
        )
        assertTrue(pauseOutcome.indexOf("if (outcome.error != null)") < pauseOutcome.indexOf("if (!accepts(outcome.operation))"))

        val detachedPause = service.substring(
            service.indexOf("private fun queueNativePauseWithoutReducer"),
            service.indexOf("private fun dispatchNativeStop"),
        )
        assertTrue(detachedPause.contains("val result = runCatching"))
        assertTrue(detachedPause.contains("postMainOutcome { handleDetachedPauseFailure"))
        assertTrue(detachedPause.contains("requestTerminalNativeStop("))
        assertEquals(1, Regex("nativeCapture\\.pause\\(\\)").findAll(service).count())
        assertEquals(1, Regex("nativeCapture\\.pauseAfterReadsLatched\\(").findAll(service).count())
    }

    @Test
    fun `in flight audio buffer is dropped after any privacy latch`() {
        assertTrue(MainaNativeReadSafetyPolicy.shouldPersistRead(320, true, false, true))
        assertFalse(MainaNativeReadSafetyPolicy.shouldPersistRead(320, true, false, false))
        assertFalse(MainaNativeReadSafetyPolicy.shouldPersistRead(320, true, true, true))
        assertFalse(MainaNativeReadSafetyPolicy.shouldPersistRead(320, false, false, true))
        assertFalse(MainaNativeReadSafetyPolicy.shouldPersistRead(0, true, false, true))
    }

    @Test
    fun `resume preparation failure always requires native ownership cleanup`() {
        assertTrue(
            MainaCaptureOperationPolicy.preparationFailureNeedsPause(
                MainaCaptureOperationKind.RESUME,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.preparationFailureNeedsPause(
                MainaCaptureOperationKind.START,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.preparationFailureNeedsPause(
                MainaCaptureOperationKind.PAUSE,
            ),
        )
    }

    @Test
    fun `route recovery cannot outlive a privacy latch generation`() {
        assertTrue(MainaNativeRecorderOwnershipPolicy.recoveryMayProceed(running = true, paused = false))
        assertFalse(MainaNativeRecorderOwnershipPolicy.recoveryMayProceed(running = true, paused = true))
        assertFalse(MainaNativeRecorderOwnershipPolicy.recoveryMayProceed(running = false, paused = false))
        assertTrue(
            MainaNativeRecorderOwnershipPolicy.ownershipMayBeReturned(
                expectedLatchGeneration = 7,
                currentLatchGeneration = 7,
                running = true,
                paused = false,
            ),
        )
        assertFalse(
            MainaNativeRecorderOwnershipPolicy.ownershipMayBeReturned(
                expectedLatchGeneration = 7,
                currentLatchGeneration = 8,
                running = true,
                paused = false,
            ),
        )
        assertFalse(
            MainaNativeRecorderOwnershipPolicy.ownershipMayBeReturned(
                expectedLatchGeneration = 7,
                currentLatchGeneration = 7,
                running = true,
                paused = true,
            ),
        )
    }

    @Test
    fun `queued start and resume cannot adopt a later privacy generation`() {
        val start = MainaCaptureOperationToken(
            operationId = 71,
            generation = 4,
            owner = MainaCapturePauseOwner.SYSTEM,
            kind = MainaCaptureOperationKind.START,
            expectedPhase = MainaCaptureControlPhase.PAUSE_PENDING,
            captureSessionId = "session-a",
            expectedPrivacyLatchGeneration = 12,
        )
        assertTrue(
            MainaCaptureOperationPolicy.nativePreparationAllowed(
                latestOperationId = 71,
                operation = start,
                currentPrivacyLatchGeneration = 12,
                communicationActive = false,
                acceptingWork = true,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.nativePreparationAllowed(
                latestOperationId = 71,
                operation = start,
                currentPrivacyLatchGeneration = 13,
                communicationActive = false,
                acceptingWork = true,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.nativePreparationAllowed(
                latestOperationId = 72,
                operation = start,
                currentPrivacyLatchGeneration = 12,
                communicationActive = false,
                acceptingWork = true,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.nativePreparationAllowed(
                latestOperationId = 71,
                operation = start,
                currentPrivacyLatchGeneration = 12,
                communicationActive = true,
                acceptingWork = true,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.nativePreparationAllowed(
                latestOperationId = 71,
                operation = start.copy(kind = MainaCaptureOperationKind.PAUSE),
                currentPrivacyLatchGeneration = 12,
                communicationActive = false,
                acceptingWork = true,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.nativePreparationAllowed(
                latestOperationId = 71,
                operation = start.copy(expectedPrivacyLatchGeneration = null),
                currentPrivacyLatchGeneration = 12,
                communicationActive = false,
                acceptingWork = true,
            ),
        )
    }

    @Test
    fun `resume queued behind manual pause reuses the reducer privacy latch`() {
        assertTrue(
            MainaPrelatchedPausePolicy.checkpointAllowed(
                expectedLatchGeneration = 18,
                currentLatchGeneration = 18,
                paused = true,
                readEnabled = false,
                systemDraining = false,
            ),
        )
        assertFalse(
            MainaPrelatchedPausePolicy.checkpointAllowed(
                expectedLatchGeneration = 18,
                currentLatchGeneration = 19,
                paused = true,
                readEnabled = false,
                systemDraining = false,
            ),
        )
        assertFalse(
            MainaPrelatchedPausePolicy.checkpointAllowed(
                expectedLatchGeneration = 18,
                currentLatchGeneration = 18,
                paused = false,
                readEnabled = false,
                systemDraining = false,
            ),
        )
        assertFalse(
            MainaPrelatchedPausePolicy.checkpointAllowed(
                expectedLatchGeneration = 18,
                currentLatchGeneration = 18,
                paused = true,
                readEnabled = true,
                systemDraining = false,
            ),
        )
        assertFalse(
            MainaPrelatchedPausePolicy.checkpointAllowed(
                expectedLatchGeneration = 18,
                currentLatchGeneration = 18,
                paused = true,
                readEnabled = false,
                systemDraining = true,
            ),
        )

        val native = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt",
        )
        val prelatchedPause = native.substring(
            native.indexOf("fun pauseAfterReadsLatched"),
            native.indexOf("fun resume(expectedLatchGeneration"),
        )
        assertTrue(prelatchedPause.contains("MainaPrelatchedPausePolicy.checkpointAllowed"))
        assertTrue(prelatchedPause.contains("expectedPrelatchedGeneration == null"))
        assertTrue(prelatchedPause.contains("latchReadsOffNow()"))

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val pauseDispatch = service.substring(
            service.indexOf("private fun dispatchNativePause"),
            service.indexOf("private fun handlePauseOutcome"),
        )
        assertTrue(pauseDispatch.contains("nativeCapture.pauseAfterReadsLatched("))
        assertTrue(pauseDispatch.contains("operation.expectedPrivacyLatchGeneration"))
        assertFalse(pauseDispatch.contains("nativeCapture.pause()"))
    }

    @Test
    fun `restored ownerless shell is the only running pause that needs no worker checkpoint`() {
        assertFalse(
            MainaNativePauseCheckpointPolicy.requiresCheckpoint(
                workerPresent = false,
                recorderPresent = false,
                preparedChunkPresent = false,
            ),
        )
        assertTrue(
            MainaNativePauseCheckpointPolicy.requiresCheckpoint(
                workerPresent = true,
                recorderPresent = false,
                preparedChunkPresent = false,
            ),
        )
        assertTrue(
            MainaNativePauseCheckpointPolicy.requiresCheckpoint(
                workerPresent = false,
                recorderPresent = true,
                preparedChunkPresent = false,
            ),
        )
        assertTrue(
            MainaNativePauseCheckpointPolicy.requiresCheckpoint(
                workerPresent = false,
                recorderPresent = false,
                preparedChunkPresent = true,
            ),
        )
    }

    @Test
    fun `stale start failure terminalizes only its own capture session`() {
        val supersedingPause = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = MainaCapturePauseOwner.MANUAL,
        )
        assertTrue(
            MainaCaptureOperationPolicy.startFailureMustTerminalize(
                MainaCaptureOperationKind.START,
                supersedingPause,
                acceptingWork = true,
                completionSessionId = "meeting-a",
                currentSessionId = "meeting-a",
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.startFailureMustTerminalize(
                MainaCaptureOperationKind.START,
                supersedingPause,
                acceptingWork = true,
                completionSessionId = "meeting-a",
                currentSessionId = "meeting-b",
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.startFailureMustTerminalize(
                MainaCaptureOperationKind.START,
                MainaCallInterruptionPolicy.terminal(supersedingPause),
                acceptingWork = true,
                completionSessionId = "meeting-a",
                currentSessionId = "meeting-a",
            ),
        )
    }

    @Test
    fun `start admission rejects every active or finalizing session`() {
        assertTrue(
            MainaCaptureOperationPolicy.startAdmissionAllowed(
                MainaCaptureControlState(phase = MainaCaptureControlPhase.IDLE),
                captureUiState = "idle",
                operationActive = false,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.startAdmissionAllowed(
                MainaCaptureControlState(phase = MainaCaptureControlPhase.PAUSE_PENDING),
                captureUiState = "idle",
                operationActive = true,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.startAdmissionAllowed(
                MainaCaptureControlState(phase = MainaCaptureControlPhase.RECORDING),
                captureUiState = "recording",
                operationActive = false,
            ),
        )
        assertFalse(
            MainaCaptureOperationPolicy.startAdmissionAllowed(
                MainaCaptureControlState(phase = MainaCaptureControlPhase.TERMINAL),
                captureUiState = "finalizing",
                operationActive = true,
            ),
        )
        assertTrue(
            MainaCaptureOperationPolicy.startAdmissionAllowed(
                MainaCaptureControlState(phase = MainaCaptureControlPhase.TERMINAL),
                captureUiState = "idle",
                operationActive = false,
            ),
        )
    }

    @Test
    fun `duplicate same meeting start is rejected before it can replace the pending attempt`() {
        // Admission is intentionally identity-independent: redelivery of the
        // same meeting ID and a different meeting are both rejected while the
        // first START token is active.
        val firstStartPending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
        )
        assertFalse(
            MainaCaptureOperationPolicy.startAdmissionAllowed(
                firstStartPending,
                captureUiState = "idle",
                operationActive = true,
            ),
        )
    }

    @Test
    fun `read commit barrier linearizes latch and rejects every later byte commit`() {
        val barrier = MainaReadCommitBarrier()
        val readEnabled = AtomicBoolean(true)
        val writes = AtomicInteger(0)
        val commitEntered = CountDownLatch(1)
        val releaseCommit = CountDownLatch(1)
        val latchStarted = CountDownLatch(1)
        val latchCompleted = CountDownLatch(1)

        val writer = Thread {
            barrier.commitIf(
                allowed = readEnabled::get,
                commit = {
                    commitEntered.countDown()
                    check(releaseCommit.await(2, TimeUnit.SECONDS))
                    writes.incrementAndGet()
                },
            )
        }
        writer.start()
        assertTrue(commitEntered.await(2, TimeUnit.SECONDS))

        val latch = Thread {
            latchStarted.countDown()
            barrier.latch { readEnabled.set(false) }
            latchCompleted.countDown()
        }
        latch.start()
        assertTrue(latchStarted.await(2, TimeUnit.SECONDS))
        assertFalse(latchCompleted.await(100, TimeUnit.MILLISECONDS))

        releaseCommit.countDown()
        assertTrue(latchCompleted.await(2, TimeUnit.SECONDS))
        writer.join(2_000L)
        latch.join(2_000L)
        assertEquals(1, writes.get())

        val admittedAfterLatch = barrier.commitIf(
            allowed = readEnabled::get,
            commit = { writes.incrementAndGet() },
        )
        assertFalse(admittedAfterLatch)
        assertEquals(1, writes.get())
    }

    @Test
    fun `privacy transition latches before throwing persistence and always queues cleanup`() {
        val order = mutableListOf<String>()
        val failure = MainaCaptureSafetySequencer.latchApplyPersistThenQueue(
            latch = { order += "latch" },
            apply = { order += "apply" },
            persist = {
                order += "persist"
                error("disk unavailable")
            },
            queue = { order += "queue" },
        )

        assertEquals(listOf("latch", "apply", "persist", "queue"), order)
        assertEquals("disk unavailable", failure?.message)
    }

    @Test
    fun `blocking persistence cannot precede privacy latch and cleanup waits in finally`() {
        val persistEntered = CountDownLatch(1)
        val releasePersistence = CountDownLatch(1)
        val completed = CountDownLatch(1)
        val order = mutableListOf<String>()
        val worker = Thread {
            MainaCaptureSafetySequencer.latchApplyPersistThenQueue(
                latch = { synchronized(order) { order += "latch" } },
                apply = { synchronized(order) { order += "apply" } },
                persist = {
                    synchronized(order) { order += "persist" }
                    persistEntered.countDown()
                    check(releasePersistence.await(2, TimeUnit.SECONDS))
                },
                queue = {
                    synchronized(order) { order += "queue" }
                    completed.countDown()
                },
            )
        }
        worker.start()

        assertTrue(persistEntered.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("latch", "apply", "persist"), synchronized(order) { order.toList() })
        assertEquals(1L, completed.count)
        releasePersistence.countDown()
        assertTrue(completed.await(2, TimeUnit.SECONDS))
        worker.join(2_000L)
        assertEquals(listOf("latch", "apply", "persist", "queue"), synchronized(order) { order.toList() })
    }

    @Test
    fun `native completion requires the exact active token phase and owner`() {
        val state = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RESUME_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 8,
        )
        val token = MainaCaptureOperationToken(
            operationId = 41,
            generation = 8,
            owner = MainaCapturePauseOwner.SYSTEM,
            kind = MainaCaptureOperationKind.RESUME,
            expectedPhase = MainaCaptureControlPhase.RESUME_PENDING,
        )
        assertTrue(MainaCaptureOperationPolicy.accepts(token, token, state))
        assertFalse(MainaCaptureOperationPolicy.accepts(token.copy(operationId = 42), token, state))
        assertFalse(MainaCaptureOperationPolicy.accepts(token, token, state.copy(pauseOwner = MainaCapturePauseOwner.MANUAL)))
        assertFalse(MainaCaptureOperationPolicy.accepts(token, token, MainaCallInterruptionPolicy.terminal(state)))
        assertFalse(MainaCaptureOperationPolicy.publicationAllowed(token, token, state, communicationActive = true))
        assertFalse(
            MainaCaptureOperationPolicy.accepts(
                token,
                token,
                state,
                acceptingWork = false,
            ),
        )
    }

    @Test
    fun `final read enable requires exact live token recording authority and clear communication`() {
        val token = MainaCaptureOperationToken(
            operationId = 51,
            generation = 12,
            owner = MainaCapturePauseOwner.MANUAL,
            kind = MainaCaptureOperationKind.RESUME,
            expectedPhase = MainaCaptureControlPhase.RESUME_PENDING,
        )
        val recording = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RECORDING,
            pauseOwner = MainaCapturePauseOwner.NONE,
            generation = 12,
        )
        assertTrue(MainaCaptureOperationPolicy.enableAllowed(token, token, recording, false, true))
        assertFalse(MainaCaptureOperationPolicy.enableAllowed(token, token, recording, true, true))
        assertFalse(MainaCaptureOperationPolicy.enableAllowed(token, token, recording, false, false))
        assertFalse(MainaCaptureOperationPolicy.enableAllowed(null, token, recording, false, true))
    }

    @Test
    fun `destroyed lifecycle rejects new work and late completion`() {
        assertTrue(MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingWork = true, destroyed = false))
        assertFalse(MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingWork = false, destroyed = false))
        assertFalse(MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingWork = true, destroyed = true))
        assertTrue(MainaCaptureLifecyclePolicy.shouldQueueDestroyStop(alreadyQueued = false))
        assertFalse(MainaCaptureLifecyclePolicy.shouldQueueDestroyStop(alreadyQueued = true))
    }

    @Test
    fun `communication clear during pause checkpoint does not stale the active native pause`() {
        val pending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 3,
            communicationActive = true,
        )
        val token = MainaCaptureOperationToken(
            operationId = 7,
            generation = pending.generation,
            owner = pending.pauseOwner,
            kind = MainaCaptureOperationKind.PAUSE,
            expectedPhase = pending.phase,
        )
        val cleared = (MainaCallInterruptionPolicy.onCommunicationChanged(pending, false)
            as MainaCaptureControlDecision.StateOnly).state
        assertTrue(cleared.generation > token.generation)
        assertTrue(MainaCaptureOperationPolicy.accepts(token, token, cleared))
    }

    @Test
    fun `stop token accepts only terminal and invalidates earlier resume`() {
        val resume = MainaCaptureOperationToken(
            operationId = 10,
            generation = 4,
            owner = MainaCapturePauseOwner.SYSTEM,
            kind = MainaCaptureOperationKind.RESUME,
            expectedPhase = MainaCaptureControlPhase.RESUME_PENDING,
        )
        val pending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RESUME_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 4,
        )
        val terminal = MainaCallInterruptionPolicy.terminal(pending)
        val stop = MainaCaptureOperationToken(
            operationId = 11,
            generation = terminal.generation,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.STOP,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
        assertFalse(MainaCaptureOperationPolicy.accepts(stop, resume, terminal))
        assertTrue(MainaCaptureOperationPolicy.accepts(stop, stop, terminal))
    }

    @Test
    fun `Android typed communication modes and silencing request privacy pause`() {
        assertFalse(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_NORMAL, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_RINGTONE, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_IN_CALL, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_IN_COMMUNICATION, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_NORMAL, true))
    }

    @Test
    fun `system pause leaves stale retained silencing to bounded native recovery after mode normal`() {
        val recording = MainaCaptureControlState(phase = MainaCaptureControlPhase.RECORDING)
        assertTrue(
            MainaCallInterruptionPolicy.reducerCommunicationActive(
                recording,
                AudioManager.MODE_NORMAL,
                clientSilenced = true,
            ),
        )

        val systemPaused = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSED,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            communicationActive = true,
        )
        assertFalse(
            MainaCallInterruptionPolicy.reducerCommunicationActive(
                systemPaused,
                AudioManager.MODE_NORMAL,
                clientSilenced = true,
            ),
        )
        assertTrue(
            MainaCallInterruptionPolicy.reducerCommunicationActive(
                systemPaused,
                AudioManager.MODE_RINGTONE,
                clientSilenced = true,
            ),
        )

        val decision = MainaCallInterruptionPolicy.onCommunicationChanged(systemPaused, active = false)
        assertTrue(decision is MainaCaptureControlDecision.Resume)
        assertEquals(
            MainaCaptureControlPhase.RESUME_PENDING,
            (decision as MainaCaptureControlDecision.Resume).state.phase,
        )
    }

    @Test
    fun `fresh recording configuration clears a missed silencing callback while refresh failure is fail closed`() {
        assertFalse(MainaCallInterruptionPolicy.refreshedClientSilenced(cached = true, observed = false))
        assertTrue(MainaCallInterruptionPolicy.refreshedClientSilenced(cached = true, observed = null))
        assertTrue(MainaCallInterruptionPolicy.refreshedClientSilenced(cached = false, observed = true))
    }

    @Test
    fun `released Maina recorder clears stale silencing and rejected call enters automatic resume`() {
        val recording = MainaCaptureControlState(phase = MainaCaptureControlPhase.RECORDING)
        val pausePending = (MainaCallInterruptionPolicy.onCommunicationChanged(recording, active = true)
            as MainaCaptureControlDecision.Pause).state
        val paused = MainaCallInterruptionPolicy.pauseSucceeded(pausePending)

        val exactRecorderSilenced = MainaCallInterruptionPolicy.refreshedClientSilenced(
            cached = true,
            observed = false,
        )
        val communicationActive = MainaCallInterruptionPolicy.communicationActive(
            audioMode = AudioManager.MODE_NORMAL,
            clientSilenced = exactRecorderSilenced,
        )
        val recovery = MainaCallInterruptionPolicy.onCommunicationChanged(paused, communicationActive)

        assertFalse(exactRecorderSilenced)
        assertFalse(communicationActive)
        assertTrue(recovery is MainaCaptureControlDecision.Resume)
        assertEquals(
            MainaCaptureControlPhase.RESUME_PENDING,
            (recovery as MainaCaptureControlDecision.Resume).state.phase,
        )
        assertEquals(MainaCapturePauseOwner.SYSTEM, recovery.state.pauseOwner)
    }

    @Test
    fun `new client silencing edge during system resume reopens communication recovery`() {
        val resumePending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RESUME_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            communicationActive = false,
            generation = 8,
        )
        assertFalse(
            MainaCallInterruptionPolicy.reducerCommunicationActive(
                resumePending,
                AudioManager.MODE_NORMAL,
                clientSilenced = true,
                clientSilencingBegan = false,
            ),
        )
        assertTrue(
            MainaCallInterruptionPolicy.reducerCommunicationActive(
                resumePending,
                AudioManager.MODE_NORMAL,
                clientSilenced = true,
                clientSilencingBegan = true,
            ),
        )
        val reentry = MainaCallInterruptionPolicy.onCommunicationChanged(resumePending, active = true)
            as MainaCaptureControlDecision.StateOnly
        assertEquals(MainaCaptureControlPhase.PAUSED, reentry.state.phase)
        assertEquals(MainaCapturePauseOwner.SYSTEM, reentry.state.pauseOwner)
        assertTrue(reentry.state.communicationActive)
        assertTrue(reentry.state.generation > resumePending.generation)
    }

    @Test
    fun `communication silencing is derived from Maina exact AudioRecord rather than global captures`() {
        val native = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt",
        )
        val exactObservation = native.substring(
            native.indexOf("fun ownClientSilenced"),
            native.indexOf("fun start(options", native.indexOf("fun ownClientSilenced")),
        )
        assertTrue(exactObservation.contains("synchronized(recorderLock)"))
        assertTrue(exactObservation.contains("recorder ?: return@synchronized false"))
        assertTrue(exactObservation.contains("activeRecordingConfiguration?.isClientSilenced"))

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val refresh = service.substring(
            service.indexOf("private fun refreshedClientSilenced"),
            service.indexOf("private fun observedCommunicationActive"),
        )
        assertTrue(refresh.contains("nativeCapture.ownClientSilenced()"))
        assertFalse(refresh.contains("audioManager.activeRecordingConfigurations"))

        val callback = service.substring(
            service.indexOf("private val recordingCallback"),
            service.indexOf("private val deviceCallback"),
        )
        assertTrue(callback.contains("reconcileCommunicationInterruption()"))
        assertFalse(callback.contains("refreshedClientSilenced()"))
        val observation = service.substring(
            service.indexOf("private fun observedCommunicationActive"),
            service.indexOf("private fun reconcileCommunicationInterruption"),
        )
        assertTrue(observation.contains("val previouslySilenced = clientSilenced"))
        assertTrue(observation.contains("val nowSilenced = refreshedClientSilenced()"))
        assertTrue(observation.contains("clientSilencingBegan = !previouslySilenced && nowSilenced"))
        assertFalse(callback.contains("clientSilenced = candidates.any"))
    }

    @Test
    fun `communication watcher runs only while capture control is active`() {
        assertFalse(MainaCallInterruptionPolicy.shouldWatchCommunication(MainaCaptureControlState()))
        for (phase in listOf(
            MainaCaptureControlPhase.RECORDING,
            MainaCaptureControlPhase.PAUSE_PENDING,
            MainaCaptureControlPhase.PAUSED,
            MainaCaptureControlPhase.RESUME_PENDING,
        )) {
            assertTrue(
                MainaCallInterruptionPolicy.shouldWatchCommunication(
                    MainaCaptureControlState(phase = phase),
                ),
            )
        }
        assertFalse(
            MainaCallInterruptionPolicy.shouldWatchCommunication(
                MainaCaptureControlState(phase = MainaCaptureControlPhase.TERMINAL),
            ),
        )
    }

    @Test
    fun `ownership publication requires exact phase generation owner and fresh communication clear`() {
        val pending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RESUME_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 14,
        )
        fun allowed(
            state: MainaCaptureControlState = pending,
            owner: MainaCapturePauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation: Long? = 14,
            active: Boolean = false,
        ) = MainaCallInterruptionPolicy.ownershipPublicationAllowed(
            state,
            MainaCaptureControlPhase.RESUME_PENDING,
            owner,
            generation,
            active,
        )

        assertTrue(allowed())
        assertFalse(allowed(active = true))
        assertFalse(allowed(owner = MainaCapturePauseOwner.MANUAL))
        assertFalse(allowed(generation = 15))
        assertFalse(allowed(state = MainaCallInterruptionPolicy.terminal(pending)))
    }

    @Test
    fun `system interruption owns one generation and resumes only after inactive`() {
        val recording = MainaCaptureControlState(phase = MainaCaptureControlPhase.RECORDING)
        val pause = MainaCallInterruptionPolicy.onCommunicationChanged(recording, true)
            as MainaCaptureControlDecision.Pause
        assertEquals(MainaCapturePauseOwner.SYSTEM, pause.state.pauseOwner)
        assertEquals(1L, pause.state.generation)
        val paused = MainaCallInterruptionPolicy.pauseSucceeded(pause.state)
        assertTrue(MainaCallInterruptionPolicy.onCommunicationChanged(paused, true) is MainaCaptureControlDecision.StateOnly)
        assertTrue(MainaCallInterruptionPolicy.onCommunicationChanged(paused, false) is MainaCaptureControlDecision.Resume)
    }

    @Test
    fun `manual pause prevents automatic resume and active communication denies manual resume`() {
        val recording = MainaCaptureControlState(phase = MainaCaptureControlPhase.RECORDING)
        val manual = (MainaCallInterruptionPolicy.onManualPause(recording) as MainaCaptureControlDecision.Pause).state
        val paused = MainaCallInterruptionPolicy.pauseSucceeded(manual)
        assertEquals(MainaCapturePauseOwner.MANUAL, paused.pauseOwner)
        assertTrue(MainaCallInterruptionPolicy.onCommunicationChanged(paused, false) is MainaCaptureControlDecision.StateOnly)
        assertTrue(
            MainaCallInterruptionPolicy.onManualResume(paused.copy(communicationActive = true))
                is MainaCaptureControlDecision.Denied,
        )
    }

    @Test
    fun `stop invalidates stale resume generations`() {
        val pending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RESUME_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 9,
        )
        val terminal = MainaCallInterruptionPolicy.terminal(pending)
        assertEquals(MainaCaptureControlPhase.TERMINAL, terminal.phase)
        assertEquals(10L, terminal.generation)
    }

    @Test
    fun `process death fails closed and preserves deliberate manual ownership`() {
        val recording = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RECORDING,
            generation = 4,
        )
        assertEquals(
            MainaProcessDeathRecoveryDisposition.FINALIZE_INTERRUPTED_CAPTURE,
            MainaCallInterruptionPolicy.processDeathRecoveryDisposition(recording),
        )
        val recovered = MainaCallInterruptionPolicy.restoreAfterProcessDeath(recording, false)
        assertEquals(MainaCaptureControlPhase.PAUSED, recovered.phase)
        assertEquals(MainaCapturePauseOwner.SYSTEM, recovered.pauseOwner)
        assertEquals(5L, recovered.generation)

        val manual = MainaCallInterruptionPolicy.restoreAfterProcessDeath(
            recording.copy(
                phase = MainaCaptureControlPhase.PAUSED,
                pauseOwner = MainaCapturePauseOwner.MANUAL,
            ),
            communicationActive = false,
        )
        assertEquals(
            MainaProcessDeathRecoveryDisposition.PRESERVE_MANUAL_PAUSE,
            MainaCallInterruptionPolicy.processDeathRecoveryDisposition(
                recording.copy(
                    phase = MainaCaptureControlPhase.PAUSED,
                    pauseOwner = MainaCapturePauseOwner.MANUAL,
                ),
            ),
        )
        assertEquals(MainaCapturePauseOwner.MANUAL, manual.pauseOwner)
        assertTrue(
            MainaCallInterruptionPolicy.onCommunicationChanged(manual, false)
                is MainaCaptureControlDecision.StateOnly,
        )
    }

    @Test
    fun `process death finalizes every non-manual active phase and never auto resumes`() {
        listOf(
            MainaCaptureControlPhase.RECORDING,
            MainaCaptureControlPhase.PAUSE_PENDING,
            MainaCaptureControlPhase.PAUSED,
            MainaCaptureControlPhase.RESUME_PENDING,
        ).forEach { phase ->
            assertEquals(
                MainaProcessDeathRecoveryDisposition.FINALIZE_INTERRUPTED_CAPTURE,
                MainaCallInterruptionPolicy.processDeathRecoveryDisposition(
                    MainaCaptureControlState(
                        phase = phase,
                        pauseOwner = MainaCapturePauseOwner.SYSTEM,
                    ),
                ),
            )
        }

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val restoration = service.substring(
            service.indexOf("private fun restoreDurableCaptureControl"),
            service.indexOf("private fun emitServiceHeartbeat"),
        )
        assertTrue(restoration.contains("process-restored-finalize"))
        assertTrue(restoration.contains("requestTerminalNativeStop"))
        assertFalse(restoration.contains("scheduleCommunicationResume"))
    }

    @Test
    fun `terminal tombstone is never restorable`() {
        val terminal = MainaCallInterruptionPolicy.terminal(
            MainaCaptureControlState(phase = MainaCaptureControlPhase.RECORDING),
        )
        assertFalse(MainaCallInterruptionPolicy.shouldRestoreAfterProcessDeath(terminal))
        assertFalse(
            MainaCallInterruptionPolicy.shouldRestoreAfterProcessDeath(
                MainaCaptureControlState(phase = MainaCaptureControlPhase.IDLE),
            ),
        )
        assertTrue(
            MainaCallInterruptionPolicy.shouldRestoreAfterProcessDeath(
                MainaCaptureControlState(phase = MainaCaptureControlPhase.PAUSED),
            ),
        )
    }

    @Test
    fun `manual pause during pending system resume invalidates automatic ownership`() {
        val systemResume = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RESUME_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 10,
            communicationActive = false,
        )
        val manualPause = MainaCallInterruptionPolicy.onManualPause(systemResume)
            as MainaCaptureControlDecision.Pause
        assertEquals(MainaCapturePauseOwner.MANUAL, manualPause.state.pauseOwner)
        assertEquals(11L, manualPause.state.generation)
        val paused = MainaCallInterruptionPolicy.pauseSucceeded(manualPause.state)
        assertTrue(
            MainaCallInterruptionPolicy.onCommunicationChanged(paused, false)
                is MainaCaptureControlDecision.StateOnly,
        )
    }

    @Test
    fun `manual pause while system checkpoint is pending still reaches manual paused`() {
        val pending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 6,
            communicationActive = true,
        )
        val decision = MainaCallInterruptionPolicy.onManualPause(pending)
            as MainaCaptureControlDecision.Pause
        assertEquals(MainaCapturePauseOwner.MANUAL, decision.state.pauseOwner)
        assertEquals(7L, decision.state.generation)
        assertEquals(
            MainaCaptureControlPhase.PAUSED,
            MainaCallInterruptionPolicy.pauseSucceeded(decision.state).phase,
        )
    }

    @Test
    fun `communication reacquisition cancels stale pending resume but retains later recovery`() {
        val pending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RESUME_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 3,
            communicationActive = false,
        )
        val reacquired = MainaCallInterruptionPolicy.onCommunicationChanged(pending, true)
            as MainaCaptureControlDecision.StateOnly
        assertEquals(MainaCaptureControlPhase.PAUSED, reacquired.state.phase)
        assertTrue(
            MainaCallInterruptionPolicy.onCommunicationChanged(reacquired.state, false)
                is MainaCaptureControlDecision.Resume,
        )
    }

    @Test
    fun `call during manual resume becomes system paused and can recover after clear`() {
        val manualResume = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.RESUME_PENDING,
            pauseOwner = MainaCapturePauseOwner.MANUAL,
            generation = 19,
            communicationActive = false,
        )
        val interrupted = MainaCallInterruptionPolicy.onCommunicationChanged(manualResume, true)
            as MainaCaptureControlDecision.StateOnly
        assertEquals(MainaCaptureControlPhase.PAUSED, interrupted.state.phase)
        assertEquals(MainaCapturePauseOwner.SYSTEM, interrupted.state.pauseOwner)
        assertTrue(interrupted.state.communicationActive)

        val cleared = MainaCallInterruptionPolicy.onCommunicationChanged(interrupted.state, false)
        assertTrue(cleared is MainaCaptureControlDecision.Resume)
    }

    @Test
    fun `short call clear during system pause checkpoint resumes after completion`() {
        val recording = MainaCaptureControlState(phase = MainaCaptureControlPhase.RECORDING)
        val pausePending = (MainaCallInterruptionPolicy.onCommunicationChanged(recording, true)
            as MainaCaptureControlDecision.Pause).state
        val clearedWhilePending = (MainaCallInterruptionPolicy.onCommunicationChanged(pausePending, false)
            as MainaCaptureControlDecision.StateOnly).state

        assertEquals(MainaCaptureControlPhase.PAUSE_PENDING, clearedWhilePending.phase)
        assertFalse(clearedWhilePending.communicationActive)
        val resume = MainaCallInterruptionPolicy.onPauseCompleted(clearedWhilePending)
            as MainaCaptureControlDecision.Resume
        assertEquals(MainaCaptureControlPhase.RESUME_PENDING, resume.state.phase)
        assertEquals(MainaCapturePauseOwner.SYSTEM, resume.state.pauseOwner)
    }

    @Test
    fun `manual pause completion never becomes an automatic resume`() {
        val manualPending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = MainaCapturePauseOwner.MANUAL,
            generation = 12,
            communicationActive = false,
        )
        val completed = MainaCallInterruptionPolicy.onPauseCompleted(manualPending)
            as MainaCaptureControlDecision.StateOnly
        assertEquals(MainaCaptureControlPhase.PAUSED, completed.state.phase)
        assertEquals(MainaCapturePauseOwner.MANUAL, completed.state.pauseOwner)
        assertEquals(12L, completed.state.generation)
    }

    @Test
    fun `failed native pause terminalizes and watcher can never auto resume it`() {
        val pending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 23,
            communicationActive = false,
        )
        val failed = MainaCallInterruptionPolicy.pauseFailed(pending)
        assertEquals(MainaCaptureControlPhase.TERMINAL, failed.phase)
        assertEquals(MainaCapturePauseOwner.SYSTEM, failed.pauseOwner)
        assertFalse(failed.communicationActive)
        val watcher = MainaCallInterruptionPolicy.onCommunicationChanged(failed, active = false)
        assertTrue(watcher is MainaCaptureControlDecision.StateOnly)
        assertEquals(MainaCaptureControlPhase.TERMINAL, (watcher as MainaCaptureControlDecision.StateOnly).state.phase)
    }

    @Test
    fun `stale system pause timeout terminalizes a superseding manual pause`() {
        val systemPending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 30,
            communicationActive = true,
        )
        val staleSystemPause = MainaCaptureOperationToken(
            operationId = 70,
            generation = 30,
            owner = MainaCapturePauseOwner.SYSTEM,
            kind = MainaCaptureOperationKind.PAUSE,
            expectedPhase = MainaCaptureControlPhase.PAUSE_PENDING,
        )
        val manualPending = (MainaCallInterruptionPolicy.onManualPause(systemPending)
            as MainaCaptureControlDecision.Pause).state
        val activeManualPause = MainaCaptureOperationToken(
            operationId = 71,
            generation = manualPending.generation,
            owner = MainaCapturePauseOwner.MANUAL,
            kind = MainaCaptureOperationKind.PAUSE,
            expectedPhase = MainaCaptureControlPhase.PAUSE_PENDING,
        )

        assertFalse(
            MainaCaptureOperationPolicy.accepts(
                activeManualPause,
                staleSystemPause,
                manualPending,
            ),
        )
        assertTrue(
            MainaCaptureOperationPolicy.pauseFailureMustTerminalize(
                manualPending,
                acceptingWork = true,
            ),
        )
        val terminal = MainaCallInterruptionPolicy.pauseFailed(manualPending)
        assertEquals(MainaCaptureControlPhase.TERMINAL, terminal.phase)
        assertFalse(
            MainaCaptureOperationPolicy.pauseFailureMustTerminalize(
                terminal,
                acceptingWork = true,
            ),
        )
    }

    @Test
    fun `terminal stop cannot be revived by a late pause completion`() {
        val terminal = MainaCallInterruptionPolicy.terminal(
            MainaCaptureControlState(
                phase = MainaCaptureControlPhase.PAUSE_PENDING,
                pauseOwner = MainaCapturePauseOwner.SYSTEM,
                generation = 5,
                communicationActive = false,
            ),
        )
        val completed = MainaCallInterruptionPolicy.onPauseCompleted(terminal)
            as MainaCaptureControlDecision.StateOnly
        assertEquals(terminal, completed.state)
        assertEquals(MainaCaptureControlPhase.TERMINAL, completed.state.phase)
    }

    @Test
    fun `system drain keeps exact recorder only when generation ownership and unsilenced state are proven`() {
        assertEquals(
            MainaRetainedRecorderState.READY,
            MainaSystemDrainPolicy.retainedRecorderState(
                generationMatches = true,
                modeNormal = true,
                recorderPresent = true,
                recorderInitialized = true,
                recorderRecording = true,
                silencingKnown = true,
                clientSilenced = false,
            ),
        )
        assertEquals(
            MainaRetainedRecorderState.INVALID,
            MainaSystemDrainPolicy.retainedRecorderState(true, true, true, true, true, true, true),
        )
        assertEquals(
            MainaRetainedRecorderState.WAITING,
            MainaSystemDrainPolicy.retainedRecorderState(
                true, true, true, true, true, true, true,
                recreationAlreadyAttempted = true,
            ),
        )
        assertEquals(
            MainaRetainedRecorderState.WAITING,
            MainaSystemDrainPolicy.retainedRecorderState(true, true, true, true, true, false, false),
        )
        assertEquals(
            MainaRetainedRecorderState.INVALID,
            MainaSystemDrainPolicy.retainedRecorderState(false, true, true, true, true, true, false),
        )
        assertEquals(
            MainaRetainedRecorderState.INVALID,
            MainaSystemDrainPolicy.retainedRecorderState(true, true, true, true, false, true, false),
        )
        assertEquals(
            MainaRetainedRecorderState.INVALID,
            MainaSystemDrainPolicy.retainedRecorderState(true, true, false, false, false, false, false),
        )
        assertEquals(
            MainaRetainedRecorderState.WAITING,
            MainaSystemDrainPolicy.retainedRecorderState(true, false, true, true, true, true, false),
        )
        assertTrue(MainaSystemDrainPolicy.recreationAllowed(drainCycle = 4, attemptedCycle = 3))
        assertFalse(MainaSystemDrainPolicy.recreationAllowed(drainCycle = 4, attemptedCycle = 4))
    }

    @Test
    fun `stably normal but silenced retained recorder recreates once and never publishes stale ownership`() {
        assertEquals(
            MainaRetainedRecorderState.INVALID,
            MainaSystemDrainPolicy.retainedRecorderState(
                generationMatches = true,
                modeNormal = true,
                recorderPresent = true,
                recorderInitialized = true,
                recorderRecording = true,
                silencingKnown = true,
                clientSilenced = true,
            ),
        )
        assertTrue(MainaSystemDrainPolicy.recreationAllowed(drainCycle = 9, attemptedCycle = 8))
        assertFalse(MainaSystemDrainPolicy.recreationAllowed(drainCycle = 9, attemptedCycle = 9))

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val observer = service.substring(
            service.indexOf("private fun observedCommunicationActive"),
            service.indexOf("private fun reconcileCommunicationInterruption"),
        )
        assertTrue(observer.contains("reducerCommunicationActive"))

        val native = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt",
        )
        val resume = native.substring(
            native.indexOf("fun resumeAfterCommunication"),
            native.indexOf("fun prepareRecordingOwnershipPublication"),
        )
        assertTrue(resume.contains("recreationAllowed"))
        assertTrue(resume.contains("recreatedRecorderIsWaitingForUnsilencing"))
        assertTrue(resume.contains("recreated-recorder-awaiting-unsilencing"))
        assertTrue(resume.contains("activeRecordingConfiguration?.isClientSilenced == false"))
        assertTrue(resume.indexOf("releaseRecorder()") < resume.indexOf("createAndStartRecorder"))
    }

    @Test
    fun `communication silencing and system drain discard every buffer`() {
        assertTrue(MainaSystemDrainPolicy.shouldPersistBuffer(320, false, false, false))
        assertFalse(MainaSystemDrainPolicy.shouldPersistBuffer(320, true, false, false))
        assertFalse(MainaSystemDrainPolicy.shouldPersistBuffer(320, false, true, false))
        assertFalse(MainaSystemDrainPolicy.shouldPersistBuffer(320, false, false, true))
        assertFalse(MainaSystemDrainPolicy.shouldPersistBuffer(0, false, false, false))
    }

    @Test
    fun `manual intent revokes system drain while a resume tap preserves system recovery ownership`() {
        val systemPaused = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSED,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 31,
            communicationActive = false,
        )
        val manualPause = MainaCallInterruptionPolicy.onManualPause(systemPaused)
            as MainaCaptureControlDecision.Pause
        assertEquals(MainaCaptureControlPhase.PAUSE_PENDING, manualPause.state.phase)
        assertEquals(MainaCapturePauseOwner.MANUAL, manualPause.state.pauseOwner)

        val requestedRecovery = MainaCallInterruptionPolicy.onManualResume(systemPaused)
            as MainaCaptureControlDecision.Resume
        assertEquals(MainaCapturePauseOwner.SYSTEM, requestedRecovery.state.pauseOwner)
        assertEquals(MainaCaptureControlPhase.RESUME_PENDING, requestedRecovery.state.phase)

        assertTrue(MainaResumeRequestPolicy.preservesCommunicationRecovery(systemPaused))
        assertEquals(
            MainaCapturePauseOwner.SYSTEM,
            MainaResumeRequestPolicy.operationOwner(requestedRecovery.state),
        )
        assertTrue(
            MainaResumeRequestPolicy.shouldRearmCommunicationRecovery(
                requestedRecovery.state,
                activeOperationPresent = false,
            ),
        )
        assertFalse(
            MainaResumeRequestPolicy.shouldRearmCommunicationRecovery(
                requestedRecovery.state,
                activeOperationPresent = true,
            ),
        )

        val pendingTap = MainaCallInterruptionPolicy.onManualResume(requestedRecovery.state)
            as MainaCaptureControlDecision.StateOnly
        assertEquals(MainaCapturePauseOwner.SYSTEM, pendingTap.state.pauseOwner)
        assertEquals(MainaCaptureControlPhase.RESUME_PENDING, pendingTap.state.phase)

        val manualPaused = systemPaused.copy(pauseOwner = MainaCapturePauseOwner.MANUAL)
        assertFalse(MainaResumeRequestPolicy.preservesCommunicationRecovery(manualPaused))
        assertEquals(MainaCapturePauseOwner.MANUAL, MainaResumeRequestPolicy.operationOwner(manualPaused))
    }

    @Test
    fun `system resume persistence failure stays latched system owned and retry eligible`() {
        val systemPaused = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSED,
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 37,
            communicationActive = false,
        )
        val requestedRecovery = MainaCallInterruptionPolicy.onManualResume(systemPaused)
            as MainaCaptureControlDecision.Resume
        val operationOwner = MainaResumeRequestPolicy.operationOwner(requestedRecovery.state)
        val failedClosed = requestedRecovery.state.copy(
            phase = MainaCaptureControlPhase.PAUSED,
            pauseOwner = operationOwner,
        )

        assertEquals(MainaCapturePauseOwner.SYSTEM, failedClosed.pauseOwner)
        assertTrue(
            MainaCallInterruptionPolicy.onCommunicationChanged(failedClosed, active = false)
                is MainaCaptureControlDecision.Resume,
        )

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val failure = service.substring(
            service.indexOf("private fun failClosedResumeDurability"),
            service.indexOf("private fun dispatchNativePause"),
        )
        assertTrue(
            failure.indexOf("nativeCapture.latchReadsOffNow()") <
                failure.indexOf("phase = MainaCaptureControlPhase.PAUSED"),
        )
        assertTrue(failure.contains("pauseOwner = owner"))
    }

    @Test
    fun `resume tap coalesces behind an in-flight native pause checkpoint`() {
        val manualPending = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = MainaCapturePauseOwner.MANUAL,
            generation = 41,
            communicationActive = false,
        )
        val manualResume = MainaCallInterruptionPolicy.onManualResume(manualPending)
            as MainaCaptureControlDecision.Resume
        assertEquals(MainaCaptureControlPhase.RESUME_PENDING, manualResume.state.phase)
        assertEquals(MainaCapturePauseOwner.MANUAL, manualResume.state.pauseOwner)
        assertEquals(42, manualResume.state.generation)

        val systemPending = manualPending.copy(
            pauseOwner = MainaCapturePauseOwner.SYSTEM,
            generation = 51,
        )
        val systemResume = MainaCallInterruptionPolicy.onManualResume(systemPending)
            as MainaCaptureControlDecision.Resume
        assertEquals(MainaCaptureControlPhase.RESUME_PENDING, systemResume.state.phase)
        assertEquals(MainaCapturePauseOwner.SYSTEM, systemResume.state.pauseOwner)
        assertEquals(52, systemResume.state.generation)

        assertTrue(
            MainaCallInterruptionPolicy.onManualResume(
                manualPending.copy(communicationActive = true),
            ) is MainaCaptureControlDecision.Denied,
        )
    }

    @Test
    fun `record screen waits for native recording ownership before clearing paused UI`() {
        val record = source("src/app/record.tsx")
        val resume = record.substring(
            record.indexOf("const resumeRecording = async"),
            record.indexOf("const stopAndSave = async"),
        )
        assertTrue(resume.indexOf("resumeNativeCapture()") < resume.indexOf("waitForNativeCaptureState("))
        assertTrue(resume.indexOf("waitForNativeCaptureState(") < resume.indexOf("pausedRef.current = false"))
        assertTrue(resume.contains("'recording'"))
        val deliveredCommand = resume.substring(
            resume.indexOf("await resumeNativeCapture()"),
            resume.indexOf("log.info('record', 'native resume requested'"),
        )
        assertFalse(deliveredCommand.contains("const resumedStatus = await getNativeCaptureStatusAsync"))
    }

    @Test
    fun `resume action coalesces system recovery and never publishes recording before reads`() {
        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val resumeAction = service.substring(
            service.indexOf("ACTION_RESUME_NATIVE_CAPTURE ->"),
            service.indexOf("ACTION_STOP_NATIVE_CAPTURE ->"),
        )
        assertTrue(resumeAction.contains("preservesCommunicationRecovery(controlState)"))
        assertTrue(resumeAction.contains("if (!preservingSystemRecovery) cancelCommunicationRetryTimer()"))
        assertTrue(resumeAction.contains("owner = operationOwner"))
        assertTrue(
            resumeAction.indexOf("val operationOwner = MainaResumeRequestPolicy.operationOwner(decision.state)") <
                resumeAction.indexOf("updateControlState(decision.state, \"manual-resume-pending\")"),
        )
        assertTrue(resumeAction.contains("failClosedResumeDurability(operationOwner)"))
        assertFalse(resumeAction.contains("failClosedResumeDurability(MainaCapturePauseOwner.MANUAL)"))
        assertTrue(resumeAction.contains("if (systemRecovery)"))
        assertTrue(resumeAction.contains("nativeCapture.resumeAfterCommunication(generation)"))
        assertTrue(resumeAction.contains("shouldRearmCommunicationRecovery"))
        assertTrue(resumeAction.contains("scheduleCommunicationResume()"))
        assertFalse(resumeAction.contains("owner = MainaCapturePauseOwner.MANUAL"))

        val publication = service.substring(
            service.indexOf("private fun handlePublicationOutcome"),
            service.indexOf("private fun rollbackCommittedPublication"),
        )
        assertTrue(
            publication.indexOf("nativeCapture.enablePreparedReads()") <
                publication.indexOf("setCaptureState(\"recording\")"),
        )
        assertTrue(
            publication.indexOf("nativeCapture.enablePreparedReads()") <
                publication.lastIndexOf("\"state\" to \"recording\""),
        )
        assertTrue(publication.contains("\"state\" to \"resuming\""))
        assertTrue(publication.contains("ui-publication-failed"))
    }

    @Test
    fun `system call source path drains without stopping and resumes retained owner before recreation fallback`() {
        val native = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt",
        )
        val systemLatch = native.substring(
            native.indexOf("fun latchSystemDrainNow"),
            native.indexOf("fun pauseForCommunication"),
        )
        assertTrue(systemLatch.contains("readCommitBarrier.latch"))
        assertTrue(systemLatch.contains("systemDraining.compareAndSet(false, true)"))
        assertFalse(systemLatch.contains(".stop()"))
        assertFalse(systemLatch.contains("releaseRecorder()"))

        val reentryLatch = native.substring(
            native.indexOf("fun revokeSystemResumeForCommunicationReentryNow"),
            native.indexOf("fun pauseForCommunication"),
        )
        assertTrue(reentryLatch.contains("latchReadsOffNow()"))
        assertTrue(reentryLatch.contains("systemDrainCycle.incrementAndGet()"))
        assertTrue(reentryLatch.contains("systemRecreationAttemptCycle.set(-1L)"))

        val systemPause = native.substring(
            native.indexOf("fun pauseForCommunication"),
            native.indexOf("fun pause(): Snapshot"),
        )
        assertTrue(systemPause.contains("latchSystemDrainNow()"))
        assertTrue(systemPause.contains("checkpoint.await"))
        assertFalse(systemPause.contains("releaseRecorder()"))

        val systemResume = native.substring(
            native.indexOf("fun resumeAfterCommunication"),
            native.indexOf("fun prepareRecordingOwnershipPublication"),
        )
        assertTrue(systemResume.indexOf("retainedRecorderState") < systemResume.indexOf("openChunk(directory)"))
        assertTrue(systemResume.contains("MainaRetainedRecorderState.READY"))
        assertTrue(systemResume.contains("createAndStartRecorder(expectedLatchGeneration)"))
        assertTrue(systemResume.contains("privacyLatchGeneration.get() == expectedLatchGeneration"))
        assertTrue(systemResume.contains("audioManager.mode == AudioManager.MODE_NORMAL"))
        assertTrue(systemResume.contains("activeRecordingConfiguration?.isClientSilenced == false"))
        assertTrue(systemResume.contains("MainaSystemDrainPolicy.recreationAllowed"))
        assertTrue(systemResume.contains("systemDraining.set(false)"))

        val loop = native.substring(
            native.indexOf("private fun recordLoop"),
            native.indexOf("private fun updateLevels"),
        )
        assertTrue(loop.contains("if (systemDraining.get())"))
        assertTrue(loop.contains("recorder?.read"))
        assertTrue(loop.contains("MainaSystemDrainPolicy.shouldPersistBuffer"))
        assertTrue(loop.contains("MainaCallInterruptionPolicy.communicationActive"))

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val communication = service.substring(
            service.indexOf("private fun reconcileCommunicationInterruption"),
            service.indexOf("private fun scheduleCommunicationResume"),
        )
        assertTrue(communication.contains("latch = nativeCapture::latchSystemDrainNow"))
        val dispatcher = service.substring(
            service.indexOf("private fun dispatchNativePause"),
            service.indexOf("private fun handlePauseOutcome"),
        )
        assertTrue(dispatcher.contains("nativeCapture.pauseForCommunication()"))
        assertTrue(dispatcher.contains("nativeCapture.pauseAfterReadsLatched("))
        assertTrue(service.contains("nativeCapture.resumeAfterCommunication("))
        assertTrue(service.contains("nativeCapture.revokeSystemResumeForCommunicationReentryNow()"))
        assertTrue(service.contains("system-retained-recorder-waiting"))
    }

    @Test
    fun `terminal publication clock starts at queue and stays monotonic through success`() {
        val stop = MainaCaptureOperationToken(
            operationId = 41,
            generation = 8,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.STOP,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
        val queued = MainaTerminalPublicationPolicy.queued(stop, nowElapsedMs = 1_000)
        val running = MainaTerminalPublicationPolicy.running(queued, stop, nowElapsedMs = 1_250)
        val succeeded = MainaTerminalPublicationPolicy.succeeded(running, stop, nowElapsedMs = 1_900)

        assertEquals(MainaTerminalPublicationPhase.QUEUED, queued.phase)
        assertEquals(MainaTerminalReasonCode.STOP_QUEUED, queued.reasonCode)
        assertEquals(MainaTerminalPublicationPhase.RUNNING, running.phase)
        assertEquals(MainaTerminalReasonCode.STOP_RUNNING, running.reasonCode)
        assertEquals(900L, succeeded.elapsedMs(1_900))
        assertEquals(MainaTerminalPublicationPhase.SUCCEEDED, succeeded.phase)
        assertEquals(MainaTerminalReasonCode.STOP_SUCCEEDED, succeeded.reasonCode)
        assertEquals(1_000L, succeeded.startedElapsedMs)
        assertEquals(MainaTerminalCompletionPublication.IDLE, MainaTerminalPublicationPolicy.completionPublication(
            nativeStopped = true,
            durableCompletion = true,
        ))
    }

    @Test
    fun `native timeout error or missing durable handoff stays recovery required`() {
        val stop = MainaCaptureOperationToken(
            operationId = 42,
            generation = 9,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.STOP,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
        val running = MainaTerminalPublicationPolicy.running(
            MainaTerminalPublicationPolicy.queued(stop, 2_000),
            stop,
            2_100,
        )
        val failed = MainaTerminalPublicationPolicy.recoveryRequired(running, stop, 17_100)

        assertEquals(MainaTerminalCompletionPublication.RECOVERY_REQUIRED, MainaTerminalPublicationPolicy.completionPublication(
            nativeStopped = false,
            durableCompletion = true,
        ))
        assertEquals(MainaTerminalCompletionPublication.RECOVERY_REQUIRED, MainaTerminalPublicationPolicy.completionPublication(
            nativeStopped = true,
            durableCompletion = false,
        ))
        assertEquals(MainaTerminalPublicationPhase.RECOVERY_REQUIRED, failed.phase)
        assertEquals(MainaTerminalReasonCode.STOP_TIMEOUT_OR_ERROR, failed.reasonCode)
        assertEquals(15_100L, failed.elapsedMs(17_100))
        assertTrue(MainaTerminalPublicationPolicy.shouldCoalesce(
            active = null,
            state = MainaCaptureControlState(phase = MainaCaptureControlPhase.TERMINAL),
            publication = failed,
        ))
    }

    @Test
    fun `external presentation cannot erase native terminal or active state`() {
        val idleControl = MainaCaptureControlState(phase = MainaCaptureControlPhase.IDLE)
        val none = MainaTerminalPublicationPolicy.initial()
        listOf("idle", "recording", "paused").forEach { requested ->
            assertTrue(MainaExternalCapturePresentationPolicy.allowed(
                requested,
                idleControl,
                activeOperation = null,
                nativeState = "idle",
                terminalPublication = none,
            ))
        }

        val stop = MainaCaptureOperationToken(
            operationId = 45,
            generation = 10,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.STOP,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
        val terminal = MainaCaptureControlState(phase = MainaCaptureControlPhase.TERMINAL)
        val queued = MainaTerminalPublicationPolicy.queued(stop, 1_000)
        val running = MainaTerminalPublicationPolicy.running(queued, stop, 1_100)
        val stale = MainaTerminalPublicationPolicy.staleSuperseded(queued, stop.copy(operationId = 46), 1_200)
        val recovery = MainaTerminalPublicationPolicy.recoveryRequired(running, stop, 2_000)
        listOf(queued, running, stale, recovery).forEach { publication ->
            assertFalse(MainaExternalCapturePresentationPolicy.allowed(
                "idle", terminal, stop, "idle", publication,
            ))
        }
        assertFalse(MainaExternalCapturePresentationPolicy.allowed(
            "idle", idleControl, null, "recording", none,
        ))
        assertFalse(MainaExternalCapturePresentationPolicy.allowed(
            "idle", idleControl, null, "idle", recovery,
        ))
        assertFalse(MainaCaptureOperationPolicy.startAdmissionAllowed(
            terminal,
            captureUiState = "error",
            operationActive = false,
        ))
    }

    @Test
    fun `route storage or native error cannot publish a clean stop`() {
        assertTrue(MainaTerminalPublicationPolicy.nativeStopIsClean("idle", null))
        listOf(
            "Audio route recovery failed",
            "Storage reserve reached",
            "Native recorder stop failed",
        ).forEach { error ->
            assertFalse(MainaTerminalPublicationPolicy.nativeStopIsClean("idle", error))
        }
        assertFalse(MainaTerminalPublicationPolicy.nativeStopIsClean("recording", null))
    }

    @Test
    fun `duplicate terminal requests coalesce without issuing another owner`() {
        val stop = MainaCaptureOperationToken(
            operationId = 50,
            generation = 3,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.STOP,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
        val terminal = MainaCaptureControlState(phase = MainaCaptureControlPhase.TERMINAL)
        val queued = MainaTerminalPublicationPolicy.queued(stop, 100)

        assertTrue(MainaTerminalPublicationPolicy.shouldCoalesce(stop, terminal, queued))
        assertTrue(MainaTerminalPublicationPolicy.shouldCoalesce(
            active = null,
            state = terminal,
            publication = MainaTerminalPublicationPolicy.succeeded(queued, stop, 200),
        ))
        assertFalse(MainaTerminalPublicationPolicy.shouldCoalesce(
            active = null,
            state = MainaCaptureControlState(phase = MainaCaptureControlPhase.RECORDING),
            publication = MainaTerminalPublicationPolicy.initial(),
        ))
    }

    @Test
    fun `prepared discard can supersede stale stop recovery but not a live terminal owner`() {
        val terminal = MainaCaptureControlState(
            phase = MainaCaptureControlPhase.TERMINAL,
            generation = 8,
        )
        assertTrue(MainaTerminalPublicationPolicy.preparedDiscardMayRun(
            active = null,
            state = terminal,
            disposition = MainaCaptureTerminalDisposition.DISCARD,
            discardId = "discard-1",
            terminalEffectReady = false,
        ))
        assertFalse(MainaTerminalPublicationPolicy.preparedDiscardMayRun(
            active = MainaCaptureOperationToken(
                operationId = 52,
                generation = 8,
                owner = MainaCapturePauseOwner.NONE,
                kind = MainaCaptureOperationKind.ABORT,
                expectedPhase = MainaCaptureControlPhase.TERMINAL,
            ),
            state = terminal,
            disposition = MainaCaptureTerminalDisposition.DISCARD,
            discardId = "discard-1",
            terminalEffectReady = false,
        ))
        assertFalse(MainaTerminalPublicationPolicy.preparedDiscardMayRun(
            active = null,
            state = terminal,
            disposition = MainaCaptureTerminalDisposition.DISCARD,
            discardId = "discard-1",
            terminalEffectReady = true,
        ))
        assertFalse(MainaTerminalPublicationPolicy.preparedDiscardMayRun(
            active = null,
            state = terminal,
            disposition = MainaCaptureTerminalDisposition.SAVE,
            discardId = null,
            terminalEffectReady = false,
        ))
    }

    @Test
    fun `discard completion remains terminal until exact cross-store acknowledgement`() {
        val abort = MainaCaptureOperationToken(
            operationId = 51,
            generation = 4,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.ABORT,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
        val ready = MainaTerminalPublicationPolicy.discardReadyForAck(
            MainaTerminalPublicationPolicy.running(
                MainaTerminalPublicationPolicy.queued(abort, 100),
                abort,
                110,
            ),
            abort.operationId,
            150,
        )
        assertEquals(MainaTerminalPublicationPhase.SUCCEEDED, ready.phase)
        assertEquals(MainaTerminalReasonCode.DISCARD_READY_FOR_ACK, ready.reasonCode)
        assertEquals(abort.operationId, ready.ownerOperationId)
    }

    @Test
    fun `one bounded terminal recovery retry requires the exact saved terminal owner`() {
        val stop = MainaCaptureOperationToken(
            operationId = 55,
            generation = 3,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.STOP,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
        val terminal = MainaCaptureControlState(phase = MainaCaptureControlPhase.TERMINAL)
        val recovery = MainaTerminalPublicationPolicy.recoveryRequired(
            MainaTerminalPublicationPolicy.running(
                MainaTerminalPublicationPolicy.queued(stop, 100),
                stop,
                110,
            ),
            stop,
            200,
        )

        assertTrue(MainaTerminalPublicationPolicy.terminalRecoveryRetryAllowed(
            active = null,
            state = terminal,
            publication = recovery,
            disposition = MainaCaptureTerminalDisposition.SAVE,
            retryAlreadyUsed = false,
        ))
        assertFalse(MainaTerminalPublicationPolicy.terminalRecoveryRetryAllowed(
            active = stop,
            state = terminal,
            publication = recovery,
            disposition = MainaCaptureTerminalDisposition.SAVE,
            retryAlreadyUsed = false,
        ))
        assertFalse(MainaTerminalPublicationPolicy.terminalRecoveryRetryAllowed(
            active = null,
            state = terminal,
            publication = recovery,
            disposition = MainaCaptureTerminalDisposition.DISCARD,
            retryAlreadyUsed = false,
        ))
        assertFalse(MainaTerminalPublicationPolicy.terminalRecoveryRetryAllowed(
            active = null,
            state = terminal,
            publication = recovery,
            disposition = MainaCaptureTerminalDisposition.SAVE,
            retryAlreadyUsed = true,
        ))
        assertFalse(MainaTerminalPublicationPolicy.terminalRecoveryRetryAllowed(
            active = null,
            state = terminal,
            publication = MainaTerminalPublicationPolicy.succeeded(recovery, stop, 300),
            disposition = MainaCaptureTerminalDisposition.SAVE,
            retryAlreadyUsed = false,
        ))
    }

    @Test
    fun `stale terminal completion needs an exact newer owner or lifecycle shutdown`() {
        val older = MainaCaptureOperationToken(
            operationId = 60,
            generation = 4,
            owner = MainaCapturePauseOwner.NONE,
            kind = MainaCaptureOperationKind.STOP,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
        val newer = older.copy(operationId = 62, kind = MainaCaptureOperationKind.ABORT)
        val terminal = MainaCaptureControlState(phase = MainaCaptureControlPhase.TERMINAL)

        assertEquals(MainaTerminalCompletionAuthority.ACCEPTED, MainaTerminalPublicationPolicy.completionAuthority(
            active = older, completion = older, state = terminal, acceptingWork = true,
        ))
        assertEquals(MainaTerminalCompletionAuthority.SUPERSEDED_BY_NEWER_TERMINAL, MainaTerminalPublicationPolicy.completionAuthority(
            active = newer, completion = older, state = terminal, acceptingWork = true,
        ))
        assertEquals(MainaTerminalCompletionAuthority.ORPHANED_STALE, MainaTerminalPublicationPolicy.completionAuthority(
            active = null, completion = older, state = terminal, acceptingWork = true,
        ))
        assertEquals(MainaTerminalCompletionAuthority.LIFECYCLE_SHUTDOWN, MainaTerminalPublicationPolicy.completionAuthority(
            active = null, completion = older, state = terminal, acceptingWork = false,
        ))
        val superseded = MainaTerminalPublicationPolicy.staleSuperseded(
            MainaTerminalPublicationPolicy.queued(older, 100),
            newer,
            200,
        )
        assertEquals(MainaTerminalPublicationPhase.STALE_SUPERSEDED, superseded.phase)
        assertEquals(MainaTerminalReasonCode.STOP_STALE_SUPERSEDED, superseded.reasonCode)
        assertEquals(newer.operationId, superseded.ownerOperationId)
    }

    @Test
    fun `native terminal owner exclusively publishes saving and truthful recovery status`() {
        val module = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt",
        )
        val setStateBridge = module.substring(
            module.indexOf("AsyncFunction(\"setCaptureState\")"),
            module.indexOf("AsyncFunction(\"startNativeCapture\")"),
        )
        assertFalse(setStateBridge.contains("\"finalizing\""))

        val record = source("src/app/record.tsx")
        val save = record.substring(
            record.indexOf("const stopAndSave = async"),
            record.indexOf("useEffect(() => {\n    stopAndSaveRef.current"),
        )
        assertTrue(save.contains("recordingSaveHandoff(CAPTURE_ENGINE)"))
        assertFalse(save.contains("setNativeCaptureState('finalizing')"))
        assertTrue(save.contains("stopNativeCapture()"))
        val nativeSave = save.substring(
            save.indexOf("if (saveHandoff === 'native-terminal-owner')"),
            save.indexOf("} else if (!pausedRef.current)"),
        )
        assertFalse(nativeSave.contains("setNativeCaptureState('idle')"))
        val saveFailure = save.substring(save.indexOf("} catch (cause)"))
        assertTrue(saveFailure.contains("saveHandoff === 'legacy-js-presentation'"))

        val cancel = record.substring(
            record.indexOf("const cancel = async"),
            record.indexOf("const confirmCancel"),
        )
        assertTrue(cancel.indexOf("nativeTerminalIntentRef.current.tryBegin('discard')") < cancel.indexOf("discardNativeMeeting({"))
        assertTrue(cancel.indexOf("savingRef.current = true") < cancel.indexOf("discardNativeMeeting({"))
        assertTrue(cancel.indexOf("setNativeSaveRecoveryBusy(true)") < cancel.indexOf("discardNativeMeeting({"))
        assertTrue(cancel.contains("native discard finalization was not acknowledged"))
        assertTrue(cancel.contains("Discard is safely retained and will finish before recovery"))
        assertTrue(cancel.contains("if (meetingCreatedRef.current && !logicalMeetingDeleted) await deleteMeeting"))
        assertTrue(cancel.contains("CAPTURE_ENGINE !== 'native-qwen'"))
        assertTrue(record.contains("if (nativeSaveSurface === 'busy')"))
        assertTrue(record.contains("label={discarding ? 'Discarding…' : 'Saving…'} disabled loading"))
        assertTrue(record.contains("const savedMeetingPendingNavigationRef = useRef<string | null>(null)"))
        assertTrue(record.contains("savedMeetingPendingNavigationRef.current = id"))
        assertTrue(record.contains("const pendingSavedMeetingId = savedMeetingPendingNavigationRef.current"))
        assertTrue(record.contains("if (savingRef.current) return;\n    if (!meetingCreatedRef.current"))

        val lifecycleCleanup = record.substring(
            record.indexOf("return () => {\n      recordScreenMountedRef.current = false"),
            record.indexOf("// This effect owns one recording session lifecycle"),
        )
        val nativeCleanup = lifecycleCleanup.substring(
            lifecycleCleanup.indexOf("if (CAPTURE_ENGINE === 'native-qwen')"),
            lifecycleCleanup.indexOf("} else {"),
        )
        assertTrue(nativeCleanup.contains("stopNativeCapture()"))
        assertFalse(nativeCleanup.contains("stopRecordingForegroundService()"))

        val service = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt",
        )
        val terminalRequest = service.substring(
            service.indexOf("private fun requestTerminalNativeStop"),
            service.indexOf("private fun accepts("),
        )
        assertTrue(terminalRequest.indexOf("beginTerminalOperation") < terminalRequest.indexOf("setCaptureState(\"finalizing\")"))
        assertTrue(terminalRequest.contains("MainaTerminalPublicationPolicy.shouldCoalesce"))

        val stopOutcome = service.substring(
            service.indexOf("private fun handleStopOutcome"),
            service.indexOf("private fun handleStopCompletion"),
        )
        assertTrue(stopOutcome.contains("MainaTerminalPublicationPolicy.completionAuthority"))
        assertTrue(stopOutcome.contains("publishTerminalRecoveryRequired"))
        assertTrue(stopOutcome.indexOf("MainaTerminalPublicationPolicy.succeeded") < stopOutcome.indexOf("setCaptureState(\"idle\")"))
        assertTrue(service.contains("\"terminalReasonCode\" to terminalPublication.reasonCode.wireValue"))
        assertTrue(service.contains("\"terminalOperationId\" to terminalPublication.ownerOperationId"))
        assertTrue(service.contains("\"error\" -> \"Maina save needs recovery\""))
        val externalState = service.substring(
            service.indexOf("if (intent?.action == ACTION_SET_STATE)"),
            service.indexOf("when (intent?.action)"),
        )
        assertTrue(externalState.contains("MainaExternalCapturePresentationPolicy.allowed"))
        assertTrue(externalState.contains("external-capture-state-rejected"))
        assertTrue(stopOutcome.contains("outcome.snapshot.lastError"))
        assertTrue(stopOutcome.contains("publishDiscardReadyForAck"))
        val durableHandoff = service.substring(
            service.indexOf("private fun handleStopCompletion"),
            service.indexOf("private fun handleAbortCompletion"),
        )
        assertTrue(durableHandoff.indexOf("outbox.begin(") < durableHandoff.indexOf("startForegroundService(intent)"))
        assertTrue(durableHandoff.contains("if (!durableHandoff) return false"))
        val durableDiscard = service.substring(
            service.indexOf("private fun handleAbortCompletion"),
            service.indexOf("private fun publishDiscardReadyForAck"),
        )
        assertTrue(durableDiscard.contains("discardMeeting(current.meetingId)"))
        assertTrue(durableDiscard.contains("markTerminalEffectReady"))
        assertFalse(durableDiscard.contains("clearIfMatches"))

        val native = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt",
        )
        val nativeStop = native.substring(
            native.indexOf("fun stop(): Snapshot"),
            native.indexOf("private fun recordLoop"),
        )
        assertTrue(nativeStop.indexOf("latchReadsOffNow()") < nativeStop.indexOf("activeWorker?.join(STOP_JOIN_TIMEOUT_MS)"))
        assertTrue(native.contains("const val STOP_JOIN_TIMEOUT_MS = 15_000L"))
    }
}

package com.divay.maina.recorder

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
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
    fun `terminal store and publication handoff source contracts stay fail closed`() {
        val store = source(
            "modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCaptureControlStore.kt",
        )
        assertTrue(
            store.contains(
                "if (phase in setOf(MainaCaptureControlPhase.IDLE, MainaCaptureControlPhase.TERMINAL)) return null",
            ),
        )

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
        assertEquals(2, Regex("nativeCapture\\.pause\\(\\)").findAll(service).count())
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
        assertTrue(callback.contains("refreshedClientSilenced()"))
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
        val recovered = MainaCallInterruptionPolicy.restoreAfterProcessDeath(recording, false)
        assertEquals(MainaCaptureControlPhase.PAUSED, recovered.phase)
        assertEquals(MainaCapturePauseOwner.SYSTEM, recovered.pauseOwner)
        assertEquals(5L, recovered.generation)

        val manual = MainaCallInterruptionPolicy.restoreAfterProcessDeath(
            recording.copy(pauseOwner = MainaCapturePauseOwner.MANUAL),
            communicationActive = false,
        )
        assertEquals(MainaCapturePauseOwner.MANUAL, manual.pauseOwner)
        assertTrue(
            MainaCallInterruptionPolicy.onCommunicationChanged(manual, false)
                is MainaCaptureControlDecision.StateOnly,
        )
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
            MainaRetainedRecorderState.WAITING,
            MainaSystemDrainPolicy.retainedRecorderState(true, true, true, true, true, true, true),
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
        assertTrue(dispatcher.contains("nativeCapture.pause()"))
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
        assertTrue(service.contains("\"error\" -> \"Maina save needs recovery\""))
        val durableHandoff = service.substring(
            service.indexOf("private fun handleStopCompletion"),
            service.indexOf("private fun handleAbortCompletion"),
        )
        assertTrue(durableHandoff.indexOf("outbox.begin(") < durableHandoff.indexOf("startForegroundService(intent)"))
        assertTrue(durableHandoff.contains("if (!durableHandoff) return false"))

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

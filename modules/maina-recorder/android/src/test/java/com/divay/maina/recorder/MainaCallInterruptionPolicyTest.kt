package com.divay.maina.recorder

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaCallInterruptionPolicyTest {
    @Test
    fun `communication and call modes pause active capture`() {
        assertTrue(MainaCallInterruptionPolicy.communicationActive(2, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(3, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(0, true))
        assertFalse(MainaCallInterruptionPolicy.communicationActive(0, false))
    }

    @Test
    fun `only automatic call pauses are automatically resumed`() {
        assertTrue(MainaCallInterruptionPolicy.shouldPause("recording", false, true))
        assertFalse(MainaCallInterruptionPolicy.shouldPause("paused", false, true))
        assertTrue(MainaCallInterruptionPolicy.shouldResume("recording", true, false))
        assertFalse(MainaCallInterruptionPolicy.shouldResume("paused", true, false))
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

package com.divay.maina.recorder

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaCallInterruptionPolicyTest {
    @Test
    fun `Android typed communication modes and silencing request privacy pause`() {
        assertFalse(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_NORMAL, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_RINGTONE, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_IN_CALL, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_IN_COMMUNICATION, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(AudioManager.MODE_NORMAL, true))
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
}

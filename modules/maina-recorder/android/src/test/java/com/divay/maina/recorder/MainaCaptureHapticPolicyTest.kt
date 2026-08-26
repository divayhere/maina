package com.divay.maina.recorder

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MainaCaptureHapticPolicyTest {
    @Test
    fun each_confirmed_capture_action_has_a_distinct_pattern() {
        assertArrayEquals(longArrayOf(0, 55, 45, 125), MainaCaptureHapticPolicy.waveform("idle", "recording"))
        assertArrayEquals(longArrayOf(0, 65, 70, 65), MainaCaptureHapticPolicy.waveform("recording", "paused"))
        assertArrayEquals(longArrayOf(0, 45, 45, 45, 45, 45), MainaCaptureHapticPolicy.waveform("paused", "recording"))
        assertArrayEquals(longArrayOf(0, 45, 45, 45, 45, 150), MainaCaptureHapticPolicy.waveform("finalizing", "idle"))
    }

    @Test
    fun unrelated_state_changes_do_not_vibrate() {
        assertNull(MainaCaptureHapticPolicy.waveform("recording", "recording"))
        assertNull(MainaCaptureHapticPolicy.waveform("idle", "finalizing"))
    }
}

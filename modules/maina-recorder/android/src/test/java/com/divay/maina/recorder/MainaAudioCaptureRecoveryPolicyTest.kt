package com.divay.maina.recorder

import android.media.AudioDeviceInfo
import android.media.AudioRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaAudioCaptureRecoveryPolicyTest {
    @Test
    fun retryDelayRisesAndCapsAtOneSecond() {
        assertEquals(100L, MainaAudioCaptureRecoveryPolicy.delayMs(0))
        assertEquals(1_000L, MainaAudioCaptureRecoveryPolicy.delayMs(3))
        assertEquals(1_000L, MainaAudioCaptureRecoveryPolicy.delayMs(99))
    }

    @Test
    fun externalRouteIsTriedBrieflyBeforeDefaultMicFallback() {
        assertTrue(MainaAudioCaptureRecoveryPolicy.shouldPreferExternalInput(0))
        assertTrue(MainaAudioCaptureRecoveryPolicy.shouldPreferExternalInput(1))
        assertFalse(MainaAudioCaptureRecoveryPolicy.shouldPreferExternalInput(2))
        assertTrue(MainaAudioCaptureRecoveryPolicy.isWithinRecoveryBudget(2_799))
        assertFalse(MainaAudioCaptureRecoveryPolicy.isWithinRecoveryBudget(2_800))
    }

    @Test
    fun deadOrInvalidRecorderIsRecoverable() {
        assertTrue(MainaAudioCaptureRecoveryPolicy.shouldRecover(AudioRecord.ERROR_DEAD_OBJECT, false))
        assertTrue(MainaAudioCaptureRecoveryPolicy.shouldRecover(AudioRecord.ERROR_INVALID_OPERATION, false))
        assertTrue(MainaAudioCaptureRecoveryPolicy.shouldRecover(-999, true))
        assertTrue(MainaAudioCaptureRecoveryPolicy.shouldRecover(AudioRecord.ERROR_BAD_VALUE, false))
        assertFalse(MainaAudioCaptureRecoveryPolicy.shouldRecover(0, false))
    }

    @Test
    fun usbReceiverWinsWhilePhoneFallbackRemainsAndroidDefault() {
        assertTrue(
            MainaAudioCaptureRecoveryPolicy.externalInputPriority(AudioDeviceInfo.TYPE_USB_HEADSET) >
                MainaAudioCaptureRecoveryPolicy.externalInputPriority(AudioDeviceInfo.TYPE_BLUETOOTH_SCO),
        )
        assertEquals(0, MainaAudioCaptureRecoveryPolicy.externalInputPriority(AudioDeviceInfo.TYPE_BUILTIN_MIC))
    }
}

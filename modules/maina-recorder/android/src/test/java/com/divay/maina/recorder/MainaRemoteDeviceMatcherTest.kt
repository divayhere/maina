package com.divay.maina.recorder

import android.view.KeyEvent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaRemoteDeviceMatcherTest {
    @Test
    fun acceptsApprovedRemoteNamesCaseInsensitively() {
        assertTrue(MainaRemoteDeviceMatcher.matchesBootstrapName("AB Shutter3"))
        assertTrue(MainaRemoteDeviceMatcher.matchesBootstrapName("Camera360"))
    }

    @Test
    fun rejectsPhoneMicrophoneAndGenericKeyboardNames() {
        assertFalse(MainaRemoteDeviceMatcher.matchesBootstrapName("gpio_keys"))
        assertFalse(MainaRemoteDeviceMatcher.matchesBootstrapName("Shenzhen Hollyland Technology Co.,Ltd Wireless microphone Consumer Control"))
        assertFalse(MainaRemoteDeviceMatcher.matchesBootstrapName("Bluetooth Keyboard"))
    }

    @Test
    fun acceptsOnlyTheCommandKeySet() {
        assertTrue(MainaRemoteDeviceMatcher.isSupportedKey(KeyEvent.KEYCODE_VOLUME_UP))
        assertTrue(MainaRemoteDeviceMatcher.isSupportedKey(KeyEvent.KEYCODE_VOLUME_DOWN))
        assertFalse(MainaRemoteDeviceMatcher.isSupportedKey(KeyEvent.KEYCODE_POWER))
        assertFalse(MainaRemoteDeviceMatcher.isSupportedKey(KeyEvent.KEYCODE_A))
    }
}

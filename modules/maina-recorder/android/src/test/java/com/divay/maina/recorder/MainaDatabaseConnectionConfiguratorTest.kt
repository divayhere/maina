package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Test

class MainaDatabaseConnectionConfiguratorTest {
    @Test
    fun usesQueryFallbackBeforePerConnectionApiExists() {
        assertEquals(
            MainaDatabaseConnectionConfigurator.BusyTimeoutMode.QUERY_FALLBACK,
            MainaDatabaseConnectionConfigurator.busyTimeoutMode(29),
        )
    }

    @Test
    fun configuresEveryConnectionOnModernAndroid() {
        assertEquals(
            MainaDatabaseConnectionConfigurator.BusyTimeoutMode.PER_CONNECTION,
            MainaDatabaseConnectionConfigurator.busyTimeoutMode(30),
        )
        assertEquals(5_000, MainaDatabaseConnectionConfigurator.BUSY_TIMEOUT_MS)
    }
}

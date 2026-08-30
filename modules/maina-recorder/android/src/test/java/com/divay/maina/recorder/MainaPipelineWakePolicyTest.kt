package com.divay.maina.recorder

import androidx.work.ExistingWorkPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class MainaPipelineWakePolicyTest {
    @Before
    fun setUp() = MainaPipelineWakeCompletion.clearForTesting()

    @After
    fun tearDown() = MainaPipelineWakeCompletion.clearForTesting()

    @Test
    fun `same generation is unique and different generations never form a chain`() {
        val generationSeven = requireNotNull(MainaPipelineWakePolicy.shared(7))
        val duplicateSeven = requireNotNull(MainaPipelineWakePolicy.shared(7))
        val generationEight = requireNotNull(MainaPipelineWakePolicy.shared(8))
        assertEquals(
            MainaPipelineWakePolicy.uniqueWorkName(generationSeven),
            MainaPipelineWakePolicy.uniqueWorkName(duplicateSeven),
        )
        assertNotEquals(
            MainaPipelineWakePolicy.uniqueWorkName(generationSeven),
            MainaPipelineWakePolicy.uniqueWorkName(generationEight),
        )
        assertEquals(ExistingWorkPolicy.KEEP, MainaPipelineWakePolicy.EXISTING_WORK_POLICY)
    }

    @Test
    fun `native runs are stable but do not expose a raw run identifier`() {
        val first = requireNotNull(MainaPipelineWakePolicy.nativeResult("meeting", "run-secret-shape"))
        val duplicate = requireNotNull(MainaPipelineWakePolicy.nativeResult("meeting", "run-secret-shape"))
        val other = requireNotNull(MainaPipelineWakePolicy.nativeResult("meeting", "run-other"))
        val name = MainaPipelineWakePolicy.uniqueWorkName(first)
        assertEquals(name, MainaPipelineWakePolicy.uniqueWorkName(duplicate))
        assertNotEquals(name, MainaPipelineWakePolicy.uniqueWorkName(other))
        assertFalse(name.contains("run-secret-shape"))
    }

    @Test
    fun `worker data round trips and malformed requests fail closed`() {
        val shared = requireNotNull(MainaPipelineWakePolicy.shared(11))
        val native = requireNotNull(MainaPipelineWakePolicy.nativeResult("meeting-a", "run-a"))
        assertEquals(shared, MainaPipelineWakeScheduler.decode(MainaPipelineWakeScheduler.encode(shared)))
        assertEquals(native, MainaPipelineWakeScheduler.decode(MainaPipelineWakeScheduler.encode(native)))
        assertNull(MainaPipelineWakePolicy.shared(-1))
        assertNull(MainaPipelineWakePolicy.nativeResult("", "run"))
    }

    @Test
    fun `retry budget is finite and later signals keep durable work intact`() {
        repeat(MainaPipelineWakePolicy.MAX_RUN_ATTEMPTS - 1) { attempt ->
            assertEquals(
                MainaPipelineWakeRetryDisposition.RETRY,
                MainaPipelineWakePolicy.retryDisposition(attempt),
            )
        }
        assertEquals(
            MainaPipelineWakeRetryDisposition.TERMINAL_FAILURE,
            MainaPipelineWakePolicy.retryDisposition(MainaPipelineWakePolicy.MAX_RUN_ATTEMPTS - 1),
        )
    }

    @Test
    fun `native completion has one owner and one terminal result`() {
        val completion = MainaPipelineWakeCompletion.register("token-a")
        assertNotNull(completion)
        assertNull(MainaPipelineWakeCompletion.register("token-a"))
        assertTrue(MainaPipelineWakeCompletion.isActive("token-a"))
        assertTrue(MainaPipelineWakeCompletion.complete("token-a", true))
        assertFalse(MainaPipelineWakeCompletion.complete("token-a", false))
        assertFalse(MainaPipelineWakeCompletion.abandon("token-a"))
        assertFalse(MainaPipelineWakeCompletion.isActive("token-a"))
    }

    @Test
    fun `timeouts stay nested inside the native worker bound`() {
        assertEquals("MainaPipelineWake", MainaPipelineHeadlessTaskLauncher.TASK_NAME)
        assertTrue(
            MainaPipelineHeadlessTaskLauncher.HEADLESS_TASK_TIMEOUT_MS
                < MainaPipelineWakeWorker.WORKER_COMPLETION_TIMEOUT_MS,
        )
        assertTrue(MainaPipelineWakeWorker.WORKER_COMPLETION_TIMEOUT_MS < 120_000L)
    }
}

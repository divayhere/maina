package com.divay.maina.recorder

import androidx.work.ExistingWorkPolicy
import androidx.work.WorkInfo
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID

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
        val shared = requireNotNull(MainaPipelineWakePolicy.shared(11, true, 42_000L, 3L))
        val native = requireNotNull(MainaPipelineWakePolicy.nativeResult("meeting-a", "run-a"))
        assertEquals(shared, MainaPipelineWakeScheduler.decode(MainaPipelineWakeScheduler.encode(shared)))
        assertEquals(native, MainaPipelineWakeScheduler.decode(MainaPipelineWakeScheduler.encode(native)))
        assertNull(MainaPipelineWakePolicy.shared(-1))
        assertNull(MainaPipelineWakePolicy.nativeResult("", "run"))
    }

    @Test
    fun `due scheduling updates only the exact pending work id and never replaces running work`() {
        assertEquals(
            MainaPipelineScheduleAction.UPDATE_PENDING,
            MainaPipelineWakePolicy.scheduleAction(WorkInfo.State.ENQUEUED, true, 50_000L, 10_000L),
        )
        assertEquals(
            MainaPipelineScheduleAction.KEEP_EXISTING,
            MainaPipelineWakePolicy.scheduleAction(WorkInfo.State.RUNNING, true, 50_000L, 10_000L),
        )
        assertEquals(
            MainaPipelineScheduleAction.KEEP_EXISTING,
            MainaPipelineWakePolicy.scheduleAction(WorkInfo.State.ENQUEUED, false, 50_000L, 10_000L),
        )
        assertEquals(
            MainaPipelineScheduleAction.ENQUEUE_NEW,
            MainaPipelineWakePolicy.scheduleAction(WorkInfo.State.SUCCEEDED, true, 50_000L, 10_000L),
        )
    }

    @Test
    fun `scheduler refuses a supplied work id whose uuid or encoded input is not exact`() {
        val request = requireNotNull(MainaPipelineWakePolicy.shared(11, true, 10_000L, 3L))
        val storedId = UUID.randomUUID()
        val otherId = UUID.randomUUID()
        val prior = request.copy(notBeforeAt = 50_000L, scheduleRevision = 2L)
        val named = listOf(
            MainaScheduledWorkSnapshot(
                storedId,
                WorkInfo.State.ENQUEUED,
                setOf(MainaPipelineWakePolicy.scheduleIdentityTag(prior)),
            ),
        )

        assertEquals(
            "previous_work_not_found",
            MainaPipelineWakeScheduler.resolveExisting(
                request, otherId.toString(), 50_000L, 2L, named,
            ).errorCode,
        )
        assertEquals(
            "previous_work_identity_mismatch",
            MainaPipelineWakeScheduler.resolveExisting(
                request,
                storedId.toString(),
                50_000L,
                99L,
                named,
            ).errorCode,
        )
    }

    @Test
    fun `scheduler preserves the exact uuid across pending update and running race`() {
        val request = requireNotNull(MainaPipelineWakePolicy.shared(11, true, 10_000L, 3L))
        val storedId = UUID.randomUUID()
        val prior = request.copy(notBeforeAt = 50_000L, scheduleRevision = 2L)
        val priorTag = MainaPipelineWakePolicy.scheduleIdentityTag(prior)
        val pending = MainaPipelineWakeScheduler.resolveExisting(
            request,
            storedId.toString(),
            50_000L,
            2L,
            listOf(MainaScheduledWorkSnapshot(storedId, WorkInfo.State.ENQUEUED, setOf(priorTag))),
        )
        val running = MainaPipelineWakeScheduler.resolveExisting(
            request,
            storedId.toString(),
            50_000L,
            2L,
            listOf(MainaScheduledWorkSnapshot(storedId, WorkInfo.State.RUNNING, setOf(priorTag))),
        )

        assertEquals(MainaPipelineScheduleAction.UPDATE_PENDING, pending.action)
        assertEquals(storedId, pending.existingId)
        assertEquals(MainaPipelineScheduleAction.KEEP_EXISTING, running.action)
        assertEquals(storedId, running.existingId)
    }

    @Test
    fun `scheduler reconciles the exact current identity after native enqueue outcome crash`() {
        val request = requireNotNull(MainaPipelineWakePolicy.shared(11, true, 10_000L, 3L))
        val storedId = UUID.randomUUID()
        val resolution = MainaPipelineWakeScheduler.resolveExisting(
            request,
            storedId.toString(),
            50_000L,
            2L,
            listOf(MainaScheduledWorkSnapshot(
                storedId,
                WorkInfo.State.ENQUEUED,
                setOf(MainaPipelineWakePolicy.scheduleIdentityTag(request)),
            )),
        )

        assertEquals(MainaPipelineScheduleAction.KEEP_EXISTING, resolution.action)
        assertEquals(storedId, resolution.existingId)
        assertNull(resolution.errorCode)
    }

    @Test
    fun `terminal exact work permits one KEEP enqueue while current matching work is reused`() {
        val request = requireNotNull(MainaPipelineWakePolicy.shared(11, true, 10_000L, 3L))
        val storedId = UUID.randomUUID()
        val prior = request.copy(notBeforeAt = 50_000L, scheduleRevision = 2L)
        val terminal = MainaPipelineWakeScheduler.resolveExisting(
            request,
            storedId.toString(),
            50_000L,
            2L,
            listOf(MainaScheduledWorkSnapshot(
                storedId,
                WorkInfo.State.SUCCEEDED,
                setOf(MainaPipelineWakePolicy.scheduleIdentityTag(prior)),
            )),
        )
        val currentId = UUID.randomUUID()
        val current = MainaPipelineWakeScheduler.resolveExisting(
            request,
            null,
            null,
            null,
            listOf(MainaScheduledWorkSnapshot(
                currentId,
                WorkInfo.State.ENQUEUED,
                setOf(MainaPipelineWakePolicy.scheduleIdentityTag(request)),
            )),
        )

        assertEquals(MainaPipelineScheduleAction.ENQUEUE_NEW, terminal.action)
        assertEquals(MainaPipelineScheduleAction.KEEP_EXISTING, current.action)
        assertEquals(currentId, current.existingId)
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
    fun `early native delivery remains retryable while truthful success terminates`() {
        assertEquals(
            MainaPipelineWorkerCompletionDisposition.RETRY,
            MainaPipelineWakePolicy.workerCompletionDisposition(false, 0),
        )
        assertEquals(
            MainaPipelineWorkerCompletionDisposition.RETRY,
            MainaPipelineWakePolicy.workerCompletionDisposition(null, 0),
        )
        assertEquals(
            MainaPipelineWorkerCompletionDisposition.TERMINAL_FAILURE,
            MainaPipelineWakePolicy.workerCompletionDisposition(
                false,
                MainaPipelineWakePolicy.MAX_RUN_ATTEMPTS - 1,
            ),
        )
        assertEquals(
            MainaPipelineWorkerCompletionDisposition.SUCCESS,
            MainaPipelineWakePolicy.workerCompletionDisposition(
                true,
                MainaPipelineWakePolicy.MAX_RUN_ATTEMPTS - 1,
            ),
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

package com.divay.maina.recorder

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaDatabaseWriterCoordinatorTest {
    @After
    fun reset() {
        MainaDatabaseWriterCoordinator.resetForTesting()
    }

    @Test
    fun recordingIsGrantedBeforeEarlierQueuedBackgroundWork() = runBlocking {
        val active = MainaDatabaseWriterCoordinator.acquire("background", 0)
        val background = async { MainaDatabaseWriterCoordinator.acquire("background", 0) }
        yield()
        val recording = async { MainaDatabaseWriterCoordinator.acquire("recording", 1_000) }
        yield()

        assertFalse(background.isCompleted)
        assertFalse(recording.isCompleted)
        assertTrue(MainaDatabaseWriterCoordinator.release(active))
        val recordingToken = recording.await()
        assertFalse(background.isCompleted)
        assertTrue(MainaDatabaseWriterCoordinator.release(recordingToken))
        val backgroundToken = background.await()
        assertTrue(MainaDatabaseWriterCoordinator.release(backgroundToken))
    }

    @Test
    fun activeWriterFinishesBeforeOneQueuedRecordingOwner() = runBlocking {
        val background = MainaDatabaseWriterCoordinator.acquire("background", 0)
        assertFalse(MainaDatabaseWriterCoordinator.isRecordingPending())
        val recording = async { MainaDatabaseWriterCoordinator.acquire("recording", 1_000) }
        yield()
        assertFalse(recording.isCompleted)
        assertTrue(MainaDatabaseWriterCoordinator.isRecordingPending())

        assertTrue(MainaDatabaseWriterCoordinator.release(background))
        val recordingToken = recording.await()
        assertTrue(MainaDatabaseWriterCoordinator.isRecordingPending())
        assertNotEquals(background, recordingToken)
        assertTrue(MainaDatabaseWriterCoordinator.release(recordingToken))
        assertFalse(MainaDatabaseWriterCoordinator.isRecordingPending())
    }

    @Test
    fun timedOutRecordingCannotReleaseOrBypassTheActiveOwner() = runBlocking {
        val background = MainaDatabaseWriterCoordinator.acquire("background", 0)
        var timedOut = false
        try {
            MainaDatabaseWriterCoordinator.acquire("recording", 1)
        } catch (_: TimeoutCancellationException) {
            timedOut = true
        }
        assertTrue(timedOut)
        assertFalse(MainaDatabaseWriterCoordinator.release("stale-token"))
        assertTrue(MainaDatabaseWriterCoordinator.release(background))

        val successor = MainaDatabaseWriterCoordinator.acquire("background", 100)
        assertTrue(MainaDatabaseWriterCoordinator.release(successor))
        assertFalse(MainaDatabaseWriterCoordinator.release(successor))
    }

    @Test
    fun moduleLeaseRegistryCannotRetainATokenAfterDestruction() {
        val registry = MainaDatabaseWriterLeaseRegistry()
        assertTrue(registry.retain("active"))
        assertEquals(listOf("active"), registry.retire())
        assertFalse(registry.retain("late-grant"))
        assertFalse(registry.release("active"))
        assertTrue(registry.retire().isEmpty())
    }

    @Test
    fun teardownPoisonsAnUnresolvedApproachAndCannotGrantAnotherRuntime() = runBlocking {
        val active = MainaDatabaseWriterCoordinator.acquire("background", 0)
        val queuedRecording = async {
            runCatching { MainaDatabaseWriterCoordinator.acquire("recording", 1_000) }.exceptionOrNull()
        }
        val queuedBackground = async {
            runCatching { MainaDatabaseWriterCoordinator.acquire("background", 0) }.exceptionOrNull()
        }
        yield()

        assertTrue(MainaDatabaseWriterCoordinator.abandon(active))
        assertTrue(queuedRecording.await() is MainaDatabaseWriterPoisonedException)
        assertTrue(queuedBackground.await() is MainaDatabaseWriterPoisonedException)
        assertFalse(MainaDatabaseWriterCoordinator.release(active))
        assertFalse(MainaDatabaseWriterCoordinator.cancel(active))
        assertFalse(MainaDatabaseWriterCoordinator.abandon(active))

        val nextRuntime = runCatching {
            MainaDatabaseWriterCoordinator.acquire("recording", 1_000)
        }.exceptionOrNull()
        assertTrue(nextRuntime is MainaDatabaseWriterPoisonedException)

        // A real process restart recreates the object. resetForTesting is the
        // deterministic equivalent and is never exposed to production code.
        MainaDatabaseWriterCoordinator.resetForTesting()
        val restarted = MainaDatabaseWriterCoordinator.acquire("recording", 100)
        assertTrue(MainaDatabaseWriterCoordinator.release(restarted))
    }
}

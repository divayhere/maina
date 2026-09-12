package com.divay.maina.recorder

import java.util.ArrayDeque
import java.util.UUID
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class MainaDatabaseWriterPoisonedException : IllegalStateException(
    "Database writer coordinator requires process restart",
)

/** Atomic module-instance custody for process-wide writer tokens. */
internal class MainaDatabaseWriterLeaseRegistry {
    private val monitor = Any()
    private val tokens = mutableSetOf<String>()
    private var retired = false

    fun retain(token: String): Boolean = synchronized(monitor) {
        if (retired) false else tokens.add(token)
    }

    fun release(token: String): Boolean = synchronized(monitor) { tokens.remove(token) }

    fun retire(): List<String> = synchronized(monitor) {
        retired = true
        tokens.toList().also { tokens.clear() }
    }
}

/**
 * One process-wide priority owner for short `maina.db` write steps.
 *
 * Foreground and headless Expo runtimes can coexist in the same application
 * process, so a module-local JavaScript mutex is not sufficient. This object is
 * shared by every MainaRecorderModule instance. SQLite BEGIN IMMEDIATE remains
 * the cross-process safety boundary; this coordinator only decides which
 * in-process writer is allowed to approach it next.
 */
object MainaDatabaseWriterCoordinator {
    private enum class Priority { RECORDING, BACKGROUND }

    private data class Waiter(
        val token: String,
        val priority: Priority,
        val resume: (String) -> Unit,
        val reject: (Throwable) -> Unit,
        val isActive: () -> Boolean,
    )

    private val monitor = Any()
    private val recording = ArrayDeque<Waiter>()
    private val background = ArrayDeque<Waiter>()
    private var activeToken: String? = null
    private var activePriority: Priority? = null
    private var poisoned = false

    fun isRecordingPending(): Boolean = synchronized(monitor) {
        activePriority == Priority.RECORDING || recording.isNotEmpty()
    }

    suspend fun acquire(priorityValue: String, timeoutMs: Long): String {
        val priority = when (priorityValue) {
            "recording" -> Priority.RECORDING
            "background" -> Priority.BACKGROUND
            else -> throw IllegalArgumentException("Unknown database writer priority")
        }
        val awaitGrant: suspend () -> String = {
            suspendCancellableCoroutine { continuation ->
                val token = UUID.randomUUID().toString()
                val waiter = Waiter(
                    token = token,
                    priority = priority,
                    resume = continuation::resume,
                    reject = continuation::resumeWithException,
                    isActive = { continuation.isActive },
                )
                continuation.invokeOnCancellation { cancel(token) }
                synchronized(monitor) {
                    if (poisoned) {
                        waiter.reject(MainaDatabaseWriterPoisonedException())
                        return@synchronized
                    }
                    queue(priority).addLast(waiter)
                    grantNextLocked()
                }
            }
        }
        return if (timeoutMs > 0L) withTimeout(timeoutMs) { awaitGrant() } else awaitGrant()
    }

    fun release(token: String): Boolean = synchronized(monitor) {
        if (poisoned) return@synchronized false
        if (activeToken != token) return@synchronized false
        activeToken = null
        activePriority = null
        grantNextLocked()
        true
    }

    fun cancel(token: String): Boolean = synchronized(monitor) {
        if (poisoned) return@synchronized false
        if (activeToken == token) {
            activeToken = null
            activePriority = null
            grantNextLocked()
            return@synchronized true
        }
        val removed = recording.removeIf { it.token == token }
            || background.removeIf { it.token == token }
        if (removed) grantNextLocked()
        removed
    }

    /**
     * A module teardown cannot prove that Expo SQLite's independent IO scope
     * finished its pending BEGIN call. Never recycle that ambiguous token into
     * another React runtime; process recreation is the only safe reset.
     */
    fun abandon(token: String): Boolean = synchronized(monitor) {
        if (poisoned || activeToken != token) return@synchronized false
        poisoned = true
        val failure = MainaDatabaseWriterPoisonedException()
        while (recording.isNotEmpty()) recording.removeFirst().reject(failure)
        while (background.isNotEmpty()) background.removeFirst().reject(failure)
        true
    }

    internal fun resetForTesting() = synchronized(monitor) {
        recording.clear()
        background.clear()
        activeToken = null
        activePriority = null
        poisoned = false
    }

    private fun queue(priority: Priority): ArrayDeque<Waiter> =
        if (priority == Priority.RECORDING) recording else background

    private fun grantNextLocked() {
        if (poisoned) return
        if (activeToken != null) return
        while (true) {
            val waiter = recording.pollFirst() ?: background.pollFirst() ?: return
            if (!waiter.isActive()) continue
            activeToken = waiter.token
            activePriority = waiter.priority
            waiter.resume(waiter.token)
            return
        }
    }
}

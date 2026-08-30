package com.divay.maina.recorder

import android.content.Context
import android.os.Looper
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

internal object MainaPipelineWakeCompletion {
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()

    fun register(token: String): CompletableDeferred<Boolean>? {
        val completion = CompletableDeferred<Boolean>()
        return if (pending.putIfAbsent(token, completion) == null) completion else null
    }

    fun complete(token: String, succeeded: Boolean): Boolean =
        pending.remove(token)?.complete(succeeded) == true

    fun isActive(token: String): Boolean = pending.containsKey(token)

    fun abandon(token: String): Boolean =
        pending.remove(token)?.let {
            it.cancel(CancellationException("Pipeline wake execution ended"))
            true
        } ?: false

    internal fun clearForTesting() {
        pending.keys.toList().forEach(::abandon)
    }
}

internal enum class MainaPipelineWakeKind(val wireValue: String) {
    SHARED("shared"),
    NATIVE_RESULT("native_result");

    companion object {
        fun fromWire(value: String?): MainaPipelineWakeKind? = entries.firstOrNull { it.wireValue == value }
    }
}

internal data class MainaPipelineWakeRequest(
    val kind: MainaPipelineWakeKind,
    val generation: Long? = null,
    val meetingId: String? = null,
    val runId: String? = null,
)

internal enum class MainaPipelineWakeRetryDisposition { RETRY, TERMINAL_FAILURE }

internal object MainaPipelineWakePolicy {
    const val UNIQUE_WORK_PREFIX = "maina-durable-pipeline-wake-v2"
    const val MAX_RUN_ATTEMPTS = 5
    val EXISTING_WORK_POLICY: ExistingWorkPolicy = ExistingWorkPolicy.KEEP

    fun shared(generation: Long): MainaPipelineWakeRequest? =
        generation.takeIf { it >= 0L }?.let {
            MainaPipelineWakeRequest(kind = MainaPipelineWakeKind.SHARED, generation = it)
        }

    fun nativeResult(meetingId: String, runId: String): MainaPipelineWakeRequest? =
        if (meetingId.isBlank() || runId.isBlank()) null else MainaPipelineWakeRequest(
            kind = MainaPipelineWakeKind.NATIVE_RESULT,
            meetingId = meetingId,
            runId = runId,
        )

    fun uniqueWorkName(request: MainaPipelineWakeRequest): String = when (request.kind) {
        MainaPipelineWakeKind.SHARED -> "$UNIQUE_WORK_PREFIX-shared-g${request.generation}"
        MainaPipelineWakeKind.NATIVE_RESULT ->
            "$UNIQUE_WORK_PREFIX-native-${fingerprint(request.runId.orEmpty())}"
    }

    fun retryDisposition(runAttemptCount: Int): MainaPipelineWakeRetryDisposition =
        if (runAttemptCount + 1 < MAX_RUN_ATTEMPTS) {
            MainaPipelineWakeRetryDisposition.RETRY
        } else {
            MainaPipelineWakeRetryDisposition.TERMINAL_FAILURE
        }

    private fun fingerprint(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .take(8)
        .joinToString("") { "%02x".format(it) }
}

/**
 * Starts the registered task inside WorkManager's existing execution window.
 * ReactHost.start() is always awaited from the Worker thread. The context is
 * then re-read and identity/active-state checked on the UI thread immediately
 * before HeadlessJsTaskContext.startTask(), avoiding a stale-context accept.
 */
internal object MainaPipelineHeadlessTaskLauncher {
    private const val REACT_START_TIMEOUT_MS = 30_000L
    private const val UI_START_TIMEOUT_MS = 5_000L

    fun launch(context: Context, attemptToken: String, request: MainaPipelineWakeRequest): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return false
        if (!MainaPipelineWakeCompletion.isActive(attemptToken)) return false
        val application = context.applicationContext as? ReactApplication ?: return false
        val reactHost = application.reactHost ?: return false
        val startTask = runCatching { reactHost.start() }.getOrNull() ?: return false
        val completed = runCatching {
            startTask.waitForCompletion(REACT_START_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        }.getOrDefault(false)
        if (!completed || startTask.isCancelled() || startTask.isFaulted()) return false
        val initializedContext = reactHost.currentReactContext ?: return false
        if (!initializedContext.hasActiveReactInstance()) return false

        val started = CountDownLatch(1)
        var accepted = false
        UiThreadUtil.runOnUiThread {
            accepted = runCatching {
                if (!MainaPipelineWakeCompletion.isActive(attemptToken)) return@runCatching false
                val current = reactHost.currentReactContext
                if (current !== initializedContext || current?.hasActiveReactInstance() != true) {
                    return@runCatching false
                }
                val data = Arguments.createMap().apply {
                    putString("attemptToken", attemptToken)
                    putString("wakeKind", request.kind.wireValue)
                    request.generation?.let { putDouble("generation", it.toDouble()) }
                    request.meetingId?.let { putString("meetingId", it) }
                    request.runId?.let { putString("runId", it) }
                }
                val taskContext = HeadlessJsTaskContext.getInstance(current)
                val taskId = taskContext.startTask(
                    HeadlessJsTaskConfig(TASK_NAME, data, HEADLESS_TASK_TIMEOUT_MS, true),
                )
                if (!current.hasActiveReactInstance()) {
                    taskContext.finishTask(taskId)
                    return@runCatching false
                }
                true
            }.getOrDefault(false)
            started.countDown()
        }
        return runCatching {
            started.await(UI_START_TIMEOUT_MS, TimeUnit.MILLISECONDS) && accepted
        }.getOrDefault(false)
    }

    const val TASK_NAME = "MainaPipelineWake"
    const val HEADLESS_TASK_TIMEOUT_MS = 90_000L
}

internal object MainaPipelineWakeScheduler {
    const val INPUT_KIND = "wake_kind"
    const val INPUT_GENERATION = "generation"
    const val INPUT_MEETING_ID = "meeting_id"
    const val INPUT_RUN_ID = "run_id"

    fun enqueueShared(context: Context, generation: Long): Boolean =
        MainaPipelineWakePolicy.shared(generation)?.let { enqueue(context, it) } ?: false

    fun enqueueNativeResult(context: Context, meetingId: String, runId: String): Boolean =
        MainaPipelineWakePolicy.nativeResult(meetingId, runId)?.let { enqueue(context, it) } ?: false

    internal fun encode(request: MainaPipelineWakeRequest): Data = Data.Builder()
        .putString(INPUT_KIND, request.kind.wireValue)
        .apply {
            request.generation?.let { putLong(INPUT_GENERATION, it) }
            request.meetingId?.let { putString(INPUT_MEETING_ID, it) }
            request.runId?.let { putString(INPUT_RUN_ID, it) }
        }
        .build()

    internal fun decode(data: Data): MainaPipelineWakeRequest? = when (
        MainaPipelineWakeKind.fromWire(data.getString(INPUT_KIND))
    ) {
        MainaPipelineWakeKind.SHARED -> MainaPipelineWakePolicy.shared(data.getLong(INPUT_GENERATION, -1L))
        MainaPipelineWakeKind.NATIVE_RESULT -> MainaPipelineWakePolicy.nativeResult(
            data.getString(INPUT_MEETING_ID).orEmpty(),
            data.getString(INPUT_RUN_ID).orEmpty(),
        )
        null -> null
    }

    private fun enqueue(context: Context, pipelineRequest: MainaPipelineWakeRequest): Boolean {
        val request = OneTimeWorkRequestBuilder<MainaPipelineWakeWorker>()
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .setInputData(encode(pipelineRequest))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .addTag(MainaPipelineWakePolicy.UNIQUE_WORK_PREFIX)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            MainaPipelineWakePolicy.uniqueWorkName(pipelineRequest),
            MainaPipelineWakePolicy.EXISTING_WORK_POLICY,
            request,
        )
        return true
    }
}

internal class MainaPipelineWakeWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val request = MainaPipelineWakeScheduler.decode(inputData) ?: return Result.failure()
        val attemptToken = UUID.randomUUID().toString()
        val completion = MainaPipelineWakeCompletion.register(attemptToken) ?: return Result.failure()
        return try {
            if (!MainaPipelineHeadlessTaskLauncher.launch(applicationContext, attemptToken, request)) {
                retryOrFail()
            } else {
                val succeeded = withTimeoutOrNull(WORKER_COMPLETION_TIMEOUT_MS) { completion.await() }
                when (succeeded) {
                    true -> Result.success()
                    false, null -> retryOrFail()
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } finally {
            MainaPipelineWakeCompletion.abandon(attemptToken)
        }
    }

    private fun retryOrFail(): Result = when (
        MainaPipelineWakePolicy.retryDisposition(runAttemptCount)
    ) {
        MainaPipelineWakeRetryDisposition.RETRY -> Result.retry()
        MainaPipelineWakeRetryDisposition.TERMINAL_FAILURE -> Result.failure()
    }

    companion object {
        const val WORKER_COMPLETION_TIMEOUT_MS = 100_000L
    }
}

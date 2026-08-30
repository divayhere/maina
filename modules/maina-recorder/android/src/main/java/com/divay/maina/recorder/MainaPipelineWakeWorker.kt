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
import androidx.work.WorkInfo
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
    val requiresNetwork: Boolean = true,
    val notBeforeAt: Long = 0L,
    val scheduleRevision: Long = 0L,
)

internal data class MainaPipelineScheduleResult(
    val scheduled: Boolean,
    val workId: String? = null,
    val errorCode: String? = null,
)

internal enum class MainaPipelineWakeRetryDisposition { RETRY, TERMINAL_FAILURE }
internal enum class MainaPipelineWorkerCompletionDisposition { SUCCESS, RETRY, TERMINAL_FAILURE }
internal enum class MainaPipelineScheduleAction { ENQUEUE_NEW, KEEP_EXISTING, UPDATE_PENDING }
internal data class MainaScheduledWorkSnapshot(
    val id: UUID,
    val state: WorkInfo.State,
    val tags: Set<String>,
)
internal data class MainaPipelineScheduleResolution(
    val action: MainaPipelineScheduleAction? = null,
    val existingId: UUID? = null,
    val errorCode: String? = null,
)

internal object MainaPipelineWakePolicy {
    const val UNIQUE_WORK_PREFIX = "maina-durable-pipeline-wake-v2"
    const val MAX_RUN_ATTEMPTS = 5
    val EXISTING_WORK_POLICY: ExistingWorkPolicy = ExistingWorkPolicy.KEEP

    fun shared(
        generation: Long,
        requiresNetwork: Boolean = true,
        notBeforeAt: Long = 0L,
        scheduleRevision: Long = 0L,
    ): MainaPipelineWakeRequest? =
        generation.takeIf { it >= 0L }?.let {
            MainaPipelineWakeRequest(
                kind = MainaPipelineWakeKind.SHARED,
                generation = it,
                requiresNetwork = requiresNetwork,
                notBeforeAt = notBeforeAt.coerceAtLeast(0L),
                scheduleRevision = scheduleRevision.coerceAtLeast(0L),
            )
        }

    fun nativeResult(meetingId: String, runId: String): MainaPipelineWakeRequest? =
        if (meetingId.isBlank() || runId.isBlank()) null else MainaPipelineWakeRequest(
            kind = MainaPipelineWakeKind.NATIVE_RESULT,
            meetingId = meetingId,
            runId = runId,
            // Importing a completed native transcript is local work and must
            // not wait for internet. Cloud transport is deferred separately.
            requiresNetwork = false,
        )

    fun uniqueWorkName(request: MainaPipelineWakeRequest): String = when (request.kind) {
        MainaPipelineWakeKind.SHARED -> "$UNIQUE_WORK_PREFIX-shared-g${request.generation}"
        MainaPipelineWakeKind.NATIVE_RESULT ->
            "$UNIQUE_WORK_PREFIX-native-${fingerprint(request.runId.orEmpty())}"
    }

    fun scheduleIdentityTag(request: MainaPipelineWakeRequest): String = when (request.kind) {
        MainaPipelineWakeKind.SHARED ->
            "$UNIQUE_WORK_PREFIX-identity-shared-g${request.generation}-r${request.scheduleRevision}" +
                "-n${if (request.requiresNetwork) 1 else 0}-d${request.notBeforeAt}"
        MainaPipelineWakeKind.NATIVE_RESULT ->
            "$UNIQUE_WORK_PREFIX-identity-native-${fingerprint(request.runId.orEmpty())}"
    }

    fun retryDisposition(runAttemptCount: Int): MainaPipelineWakeRetryDisposition =
        if (runAttemptCount + 1 < MAX_RUN_ATTEMPTS) {
            MainaPipelineWakeRetryDisposition.RETRY
        } else {
            MainaPipelineWakeRetryDisposition.TERMINAL_FAILURE
        }

    fun workerCompletionDisposition(
        succeeded: Boolean?,
        runAttemptCount: Int,
    ): MainaPipelineWorkerCompletionDisposition = when {
        succeeded == true -> MainaPipelineWorkerCompletionDisposition.SUCCESS
        retryDisposition(runAttemptCount) == MainaPipelineWakeRetryDisposition.RETRY ->
            MainaPipelineWorkerCompletionDisposition.RETRY
        else -> MainaPipelineWorkerCompletionDisposition.TERMINAL_FAILURE
    }

    fun scheduleAction(
        state: WorkInfo.State?,
        exactStoredId: Boolean,
        previousNotBeforeAt: Long?,
        requestedNotBeforeAt: Long,
    ): MainaPipelineScheduleAction = when {
        state == null || state.isFinished -> MainaPipelineScheduleAction.ENQUEUE_NEW
        state == WorkInfo.State.RUNNING -> MainaPipelineScheduleAction.KEEP_EXISTING
        exactStoredId
            && previousNotBeforeAt != null
            && requestedNotBeforeAt < previousNotBeforeAt
            && (state == WorkInfo.State.ENQUEUED || state == WorkInfo.State.BLOCKED) ->
            MainaPipelineScheduleAction.UPDATE_PENDING
        else -> MainaPipelineScheduleAction.KEEP_EXISTING
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
    const val INPUT_REQUIRES_NETWORK = "requires_network"
    const val INPUT_NOT_BEFORE_AT = "not_before_at"
    const val INPUT_SCHEDULE_REVISION = "schedule_revision"
    private const val ENQUEUE_TIMEOUT_SECONDS = 10L

    fun enqueueShared(
        context: Context,
        generation: Long,
        requiresNetwork: Boolean,
        notBeforeAt: Long,
        scheduleRevision: Long,
        previousWorkId: String?,
        previousNotBeforeAt: Long?,
        previousScheduleRevision: Long?,
    ): MainaPipelineScheduleResult = MainaPipelineWakePolicy.shared(
        generation,
        requiresNetwork,
        notBeforeAt,
        scheduleRevision,
    )
        ?.let {
            enqueue(
                context,
                it,
                previousWorkId,
                previousNotBeforeAt,
                previousScheduleRevision,
            )
        }
        ?: MainaPipelineScheduleResult(false, errorCode = "invalid_generation")

    fun enqueueNativeResult(context: Context, meetingId: String, runId: String): MainaPipelineScheduleResult =
        MainaPipelineWakePolicy.nativeResult(meetingId, runId)?.let { enqueue(context, it) }
            ?: MainaPipelineScheduleResult(false, errorCode = "invalid_native_result")

    internal fun encode(request: MainaPipelineWakeRequest): Data = Data.Builder()
        .putString(INPUT_KIND, request.kind.wireValue)
        .apply {
            request.generation?.let { putLong(INPUT_GENERATION, it) }
            request.meetingId?.let { putString(INPUT_MEETING_ID, it) }
            request.runId?.let { putString(INPUT_RUN_ID, it) }
            putBoolean(INPUT_REQUIRES_NETWORK, request.requiresNetwork)
            putLong(INPUT_NOT_BEFORE_AT, request.notBeforeAt)
            putLong(INPUT_SCHEDULE_REVISION, request.scheduleRevision)
        }
        .build()

    internal fun decode(data: Data): MainaPipelineWakeRequest? = when (
        MainaPipelineWakeKind.fromWire(data.getString(INPUT_KIND))
    ) {
        MainaPipelineWakeKind.SHARED -> MainaPipelineWakePolicy.shared(
            data.getLong(INPUT_GENERATION, -1L),
            data.getBoolean(INPUT_REQUIRES_NETWORK, true),
            data.getLong(INPUT_NOT_BEFORE_AT, 0L),
            data.getLong(INPUT_SCHEDULE_REVISION, 0L),
        )
        MainaPipelineWakeKind.NATIVE_RESULT -> MainaPipelineWakePolicy.nativeResult(
            data.getString(INPUT_MEETING_ID).orEmpty(),
            data.getString(INPUT_RUN_ID).orEmpty(),
        )
        null -> null
    }

    internal fun resolveExisting(
        request: MainaPipelineWakeRequest,
        previousWorkId: String?,
        previousNotBeforeAt: Long?,
        previousScheduleRevision: Long?,
        named: List<MainaScheduledWorkSnapshot>,
    ): MainaPipelineScheduleResolution {
        if (previousWorkId != null) {
            val expectedId = runCatching { UUID.fromString(previousWorkId) }.getOrNull()
                ?: return MainaPipelineScheduleResolution(errorCode = "invalid_previous_work_id")
            val exact = named.firstOrNull { it.id == expectedId }
                ?: return MainaPipelineScheduleResolution(errorCode = "previous_work_not_found")
            val priorDue = previousNotBeforeAt
                ?: return MainaPipelineScheduleResolution(errorCode = "previous_work_due_missing")
            val priorRevision = previousScheduleRevision
                ?: return MainaPipelineScheduleResolution(errorCode = "previous_work_revision_missing")
            val expectedPriorTags = listOf(false, true).map { requiredNetwork ->
                MainaPipelineWakePolicy.scheduleIdentityTag(
                    request.copy(
                        requiresNetwork = requiredNetwork,
                        notBeforeAt = priorDue,
                        scheduleRevision = priorRevision,
                    ),
                )
            }
            val priorIdentityMatches = expectedPriorTags.any(exact.tags::contains)
            val currentIdentityMatches = MainaPipelineWakePolicy.scheduleIdentityTag(request) in exact.tags
            if (!priorIdentityMatches && !currentIdentityMatches) {
                return MainaPipelineScheduleResolution(errorCode = "previous_work_identity_mismatch")
            }
            if (currentIdentityMatches) {
                return MainaPipelineScheduleResolution(
                    action = if (exact.state.isFinished) {
                        MainaPipelineScheduleAction.ENQUEUE_NEW
                    } else {
                        MainaPipelineScheduleAction.KEEP_EXISTING
                    },
                    existingId = exact.id,
                )
            }
            return MainaPipelineScheduleResolution(
                action = MainaPipelineWakePolicy.scheduleAction(
                    exact.state,
                    true,
                    priorDue,
                    request.notBeforeAt,
                ),
                existingId = exact.id,
            )
        }

        val identityTag = MainaPipelineWakePolicy.scheduleIdentityTag(request)
        val unfinished = named.filter { !it.state.isFinished }
        val matching = unfinished.filter { identityTag in it.tags }
        if (matching.size > 1) {
            return MainaPipelineScheduleResolution(errorCode = "ambiguous_matching_work")
        }
        if (matching.size == 1) {
            return MainaPipelineScheduleResolution(
                action = MainaPipelineScheduleAction.KEEP_EXISTING,
                existingId = matching.single().id,
            )
        }
        if (unfinished.isNotEmpty()) {
            return MainaPipelineScheduleResolution(errorCode = "conflicting_named_work")
        }
        return MainaPipelineScheduleResolution(action = MainaPipelineScheduleAction.ENQUEUE_NEW)
    }

    private fun buildRequest(
        pipelineRequest: MainaPipelineWakeRequest,
        id: UUID = UUID.randomUUID(),
    ) = OneTimeWorkRequestBuilder<MainaPipelineWakeWorker>()
            .setId(id)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(
                    if (pipelineRequest.requiresNetwork) NetworkType.CONNECTED else NetworkType.NOT_REQUIRED,
                ).build(),
            )
            .setInputData(encode(pipelineRequest))
            .setInitialDelay(
                (pipelineRequest.notBeforeAt - System.currentTimeMillis()).coerceAtLeast(0L),
                TimeUnit.MILLISECONDS,
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .addTag(MainaPipelineWakePolicy.UNIQUE_WORK_PREFIX)
            .addTag(MainaPipelineWakePolicy.scheduleIdentityTag(pipelineRequest))
            .build()

    private fun snapshots(workInfos: List<WorkInfo>) = workInfos.map {
        MainaScheduledWorkSnapshot(it.id, it.state, it.tags)
    }

    private fun enqueue(
        context: Context,
        pipelineRequest: MainaPipelineWakeRequest,
        previousWorkId: String? = null,
        previousNotBeforeAt: Long? = null,
        previousScheduleRevision: Long? = null,
    ): MainaPipelineScheduleResult {
        return runCatching {
            val manager = WorkManager.getInstance(context.applicationContext)
            val uniqueName = MainaPipelineWakePolicy.uniqueWorkName(pipelineRequest)
            val named = manager.getWorkInfosForUniqueWork(uniqueName)
                .get(ENQUEUE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            var resolution = resolveExisting(
                pipelineRequest,
                previousWorkId,
                previousNotBeforeAt,
                previousScheduleRevision,
                snapshots(named),
            )
            if (resolution.errorCode != null) {
                return@runCatching MainaPipelineScheduleResult(
                    false,
                    workId = previousWorkId,
                    errorCode = resolution.errorCode,
                )
            }

            when (resolution.action) {
                MainaPipelineScheduleAction.UPDATE_PENDING -> {
                    val existingId = checkNotNull(resolution.existingId)
                    // Re-read immediately before update. If the exact work won
                    // the RUNNING race, leave that execution untouched.
                    val refreshed = manager.getWorkInfosForUniqueWork(uniqueName)
                        .get(ENQUEUE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                    resolution = resolveExisting(
                        pipelineRequest,
                        previousWorkId,
                        previousNotBeforeAt,
                        previousScheduleRevision,
                        snapshots(refreshed),
                    )
                    if (resolution.errorCode != null) {
                        return@runCatching MainaPipelineScheduleResult(
                            false,
                            workId = previousWorkId,
                            errorCode = resolution.errorCode,
                        )
                    }
                    if (resolution.action == MainaPipelineScheduleAction.KEEP_EXISTING) {
                        return@runCatching MainaPipelineScheduleResult(true, workId = existingId.toString())
                    }
                    if (resolution.action != MainaPipelineScheduleAction.UPDATE_PENDING) {
                        // The exact prior request finished between reads. KEEP
                        // below may now enqueue the same generation safely.
                    } else {
                        val updated = buildRequest(pipelineRequest, existingId)
                        val updateResult = manager.updateWork(updated)
                            .get(ENQUEUE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                        if (updateResult != WorkManager.UpdateResult.NOT_APPLIED) {
                            return@runCatching MainaPipelineScheduleResult(
                                true,
                                workId = existingId.toString(),
                            )
                        }
                        val raced = manager.getWorkInfosForUniqueWork(uniqueName)
                            .get(ENQUEUE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                            .firstOrNull { it.id == existingId }
                        if (raced?.state == WorkInfo.State.RUNNING) {
                            return@runCatching MainaPipelineScheduleResult(
                                true,
                                workId = existingId.toString(),
                            )
                        }
                        return@runCatching MainaPipelineScheduleResult(
                            false,
                            workId = existingId.toString(),
                            errorCode = "update_not_applied",
                        )
                    }
                }
                MainaPipelineScheduleAction.KEEP_EXISTING -> {
                    val existingId = checkNotNull(resolution.existingId)
                    // RUNNING work is never cancelled or replaced. SQLite
                    // claims make it observe the current durable truth.
                    return@runCatching MainaPipelineScheduleResult(true, workId = existingId.toString())
                }
                MainaPipelineScheduleAction.ENQUEUE_NEW -> Unit
                null -> error("missing_schedule_resolution")
            }

            val request = buildRequest(pipelineRequest)
            manager.enqueueUniqueWork(
                uniqueName,
                MainaPipelineWakePolicy.EXISTING_WORK_POLICY,
                request,
            ).result.get(ENQUEUE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            val accepted = manager.getWorkInfosForUniqueWork(uniqueName)
                .get(ENQUEUE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .firstOrNull {
                    it.id == request.id
                        && !it.state.isFinished
                        && MainaPipelineWakePolicy.scheduleIdentityTag(pipelineRequest) in it.tags
                }
            MainaPipelineScheduleResult(
                scheduled = accepted != null,
                workId = accepted?.id?.toString(),
                errorCode = if (accepted == null) "enqueue_not_observed" else null,
            )
        }.getOrElse { cause ->
            MainaPipelineScheduleResult(
                false,
                workId = previousWorkId,
                errorCode = cause.javaClass.simpleName,
            )
        }
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
                resultForCompletion(succeeded)
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

    private fun resultForCompletion(succeeded: Boolean?): Result = when (
        MainaPipelineWakePolicy.workerCompletionDisposition(succeeded, runAttemptCount)
    ) {
        MainaPipelineWorkerCompletionDisposition.SUCCESS -> Result.success()
        MainaPipelineWorkerCompletionDisposition.RETRY -> Result.retry()
        MainaPipelineWorkerCompletionDisposition.TERMINAL_FAILURE -> Result.failure()
    }

    companion object {
        const val WORKER_COMPLETION_TIMEOUT_MS = 100_000L
    }
}

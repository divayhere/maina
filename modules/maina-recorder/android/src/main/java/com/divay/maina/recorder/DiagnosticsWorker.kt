package com.divay.maina.recorder

import android.content.Context
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

internal object DiagnosticsScheduler {
    private const val EVENT_WORK = "maina-diagnostics-events-v2"
    private const val ARTIFACT_WORK = "maina-diagnostics-artifacts-v2"
    private const val RETENTION_WORK = "maina-diagnostics-retention"

    fun enqueueEvents(context: Context, replace: Boolean = false, urgent: Boolean = false) =
        enqueueLane(
            context,
            EVENT_WORK,
            "events",
            replace,
            requireStorage = false,
            requireBatteryNotLow = false,
            delaySeconds = if (urgent || replace) 0 else 30,
        )

    fun enqueueArtifacts(context: Context, replace: Boolean = false) =
        enqueueLane(
            context,
            ARTIFACT_WORK,
            "artifacts",
            replace,
            requireStorage = true,
            requireBatteryNotLow = true,
            delaySeconds = if (replace) 0 else 10,
        )

    private fun enqueueLane(
        context: Context,
        workName: String,
        lane: String,
        replace: Boolean,
        requireStorage: Boolean,
        requireBatteryNotLow: Boolean,
        delaySeconds: Long,
    ) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresStorageNotLow(requireStorage)
            .setRequiresBatteryNotLow(requireBatteryNotLow)
            .build()
        val request = OneTimeWorkRequestBuilder<DiagnosticsWorker>()
            .setConstraints(constraints)
            .setInputData(workDataOf("lane" to lane))
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(workName)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            workName,
            if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
            request,
        )
    }

    fun ensurePeriodicWork(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()
        val request = PeriodicWorkRequestBuilder<DiagnosticsWorker>(24, TimeUnit.HOURS)
            .setConstraints(constraints)
            .setInputData(workDataOf("lane" to "maintenance"))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(RETENTION_WORK)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            RETENTION_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }
}

internal class DiagnosticsWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val store = DiagnosticsStore.shared(applicationContext)
        try {
            val config = store.config()
            if (!config.enabled || config.supabaseUrl.isBlank() || config.publishableKey.isBlank()) {
                return@withContext Result.success()
            }
            when (inputData.getString("lane") ?: "events") {
                "events" -> {
                    flushOutbox(store, config)
                    store.markUploadSuccess()
                    Result.success()
                }
                "artifacts" -> {
                    val artifactFailures = uploadArtifacts(store, config)
                    // Artifact metadata and any failure event are small and may
                    // be delivered here, but never hold the independent event lane.
                    flushOutbox(store, config)
                    if (artifactFailures) Result.retry() else Result.success()
                }
                "maintenance" -> {
                    deleteExpiredArtifacts(store, config)
                    store.cleanupRetainedLocalSources()
                    Result.success()
                }
                else -> Result.failure()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            store.setLastError(error.message ?: error.javaClass.simpleName)
            Result.retry()
        }
    }

    private suspend fun flushOutbox(store: DiagnosticsStore, config: DiagnosticConfig) {
        TABLES.forEach { table ->
            while (true) {
                currentCoroutineContext().ensureActive()
                val batch = store.nextOutbox(table, 50)
                if (batch.isEmpty()) break
                val payload = JSONArray().apply { batch.forEach { put(org.json.JSONObject(it.payload)) } }
                val conflict = when (table) {
                    "diagnostic_runs" -> "run_id"
                    "diagnostic_artifacts" -> "artifact_id"
                    else -> "event_id"
                }
                val response = request(
                    method = "POST",
                    url = "${config.supabaseUrl}/rest/v1/$table?on_conflict=$conflict",
                    config = config,
                    contentType = "application/json",
                    bodyWriter = { output -> output.write(payload.toString().toByteArray(Charsets.UTF_8)) },
                    extraHeaders = mapOf("Prefer" to "resolution=ignore-duplicates,return=minimal"),
                )
                if (response.code !in 200..299) {
                    val message = "$table upload HTTP ${response.code}: ${response.body.take(500)}"
                    store.markOutboxFailure(batch.map { it.recordId }, message)
                    throw IllegalStateException(message)
                }
                store.acknowledgeOutbox(batch.map { it.recordId })
            }
        }
    }

    private suspend fun uploadArtifacts(store: DiagnosticsStore, config: DiagnosticConfig): Boolean {
        val outputDir = File(applicationContext.cacheDir, "maina-diagnostic-compressed")
        val attempted = mutableSetOf<String>()
        var hadFailures = false
        while (true) {
            currentCoroutineContext().ensureActive()
            val batch = store.pendingArtifacts(ARTIFACT_BATCH_SIZE).filterNot { it.artifactId in attempted }
            if (batch.isEmpty()) break
            for (artifact in batch) {
                attempted += artifact.artifactId
                currentCoroutineContext().ensureActive()
                try {
                    val prepared = DiagnosticAudioTranscoder.prepare(artifact, outputDir)
                    val objectPath = store.markArtifactPrepared(artifact.artifactId, prepared)
                    val response = request(
                        method = "POST",
                        url = storageObjectUrl(config, objectPath),
                        config = config,
                        contentType = prepared.contentType,
                        bodyWriter = { output ->
                            File(prepared.path).inputStream().buffered().use { input ->
                                val buffer = ByteArray(64 * 1024)
                                while (true) {
                                    if (isStopped) throw CancellationException("Diagnostics worker stopped during upload")
                                    val count = input.read(buffer)
                                    if (count <= 0) break
                                    output.write(buffer, 0, count)
                                }
                            }
                        },
                        extraHeaders = mapOf(
                            "x-upsert" to "false",
                            "cache-control" to "0",
                        ),
                    )
                    // Storage normally returns 409 when a previous attempt
                    // completed but its response was lost. Some gateway
                    // versions wrap that same Storage conflict as HTTP 400
                    // with code=KeyAlreadyExists, so treat both spellings as
                    // an idempotent success. The metadata upsert below then
                    // records the already-existing object exactly once.
                    if (response.code !in 200..299 && !isAlreadyStored(response)) {
                        error("artifact upload HTTP ${response.code}: ${response.body.take(500)}")
                    }
                    store.markArtifactUploaded(artifact.copy(objectPath = objectPath), prepared)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    val message = error.message ?: error.javaClass.simpleName
                    store.markArtifactFailure(artifact.artifactId, message)
                    enqueueArtifactFailure(store, artifact, message, error)
                    hadFailures = true
                }
            }
        }
        return hadFailures
    }

    private fun enqueueArtifactFailure(
        store: DiagnosticsStore,
        artifact: ArtifactRecord,
        message: String,
        error: Throwable,
    ) {
        val now = System.currentTimeMillis()
        store.enqueueEvents(
            listOf(
                mapOf(
                    "eventId" to java.util.UUID.randomUUID().toString(),
                    "occurredAt" to java.time.Instant.ofEpochMilli(now).toString(),
                    "elapsedMs" to 0L,
                    "sequence" to 0L,
                    "level" to "error",
                    "category" to "native-diagnostics",
                    "eventName" to "artifact-processing-failed",
                    "message" to "Diagnostic artifact processing failed",
                    "meetingId" to artifact.meetingId,
                    "segmentIndex" to artifact.segmentIndex,
                    "payload" to mapOf(
                        "artifactId" to artifact.artifactId,
                        "kind" to artifact.kind,
                        "sourcePath" to artifact.sourcePath,
                        "sourceExists" to mainaFileFromUriOrPath(artifact.sourcePath).isFile,
                        "sourceBytes" to mainaFileFromUriOrPath(artifact.sourcePath)
                            .takeIf { it.isFile }
                            ?.length(),
                        "attempt" to artifact.attempts + 1,
                        "errorClass" to error.javaClass.name,
                        "error" to message.take(1000),
                    ),
                ),
            ),
        )
    }

    private suspend fun deleteExpiredArtifacts(store: DiagnosticsStore, config: DiagnosticConfig) {
        while (true) {
            currentCoroutineContext().ensureActive()
            val batch = store.expiredArtifacts(System.currentTimeMillis(), RETENTION_BATCH_SIZE)
            if (batch.isEmpty()) break
            for (artifact in batch) {
                currentCoroutineContext().ensureActive()
                val path = requireNotNull(artifact.objectPath) {
                    "Uploaded artifact ${artifact.artifactId} has no remote object path"
                }
                val response = request(
                    method = "DELETE",
                    url = storageObjectUrl(config, path),
                    config = config,
                    contentType = null,
                    bodyWriter = null,
                )
                if (response.code in 200..299 || response.code == 404) {
                    store.markRemoteDeleted(artifact.artifactId)
                } else {
                    error("artifact retention delete HTTP ${response.code}: ${response.body.take(500)}")
                }
            }
        }
    }

    private fun storageObjectUrl(config: DiagnosticConfig, objectPath: String): String {
        val builder = Uri.parse("${config.supabaseUrl}/storage/v1/object").buildUpon()
            .appendPath(config.bucket)
        objectPath.split('/').forEach { builder.appendPath(it) }
        return builder.build().toString()
    }

    private data class HttpResponse(val code: Int, val body: String)

    private fun isAlreadyStored(response: HttpResponse): Boolean =
        response.code == 409 || response.body.contains("KeyAlreadyExists", ignoreCase = true)

    private fun request(
        method: String,
        url: String,
        config: DiagnosticConfig,
        contentType: String?,
        bodyWriter: ((java.io.OutputStream) -> Unit)?,
        extraHeaders: Map<String, String> = emptyMap(),
    ): HttpResponse {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 30_000
            connection.readTimeout = 120_000
            connection.setRequestProperty("apikey", config.publishableKey)
            connection.setRequestProperty("Authorization", "Bearer ${config.publishableKey}")
            connection.setRequestProperty("User-Agent", "Maina/${config.appVersion} Android")
            if (contentType != null) connection.setRequestProperty("Content-Type", contentType)
            extraHeaders.forEach(connection::setRequestProperty)
            if (bodyWriter != null) {
                connection.doOutput = true
                connection.outputStream.buffered().use(bodyWriter)
            }
            val code = connection.responseCode
            val stream = if (code >= 400) connection.errorStream else connection.inputStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            return HttpResponse(code, body)
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val ARTIFACT_BATCH_SIZE = 16
        private const val RETENTION_BATCH_SIZE = 20
        private val TABLES = listOf("diagnostic_events", "diagnostic_runs", "diagnostic_artifacts")
    }
}

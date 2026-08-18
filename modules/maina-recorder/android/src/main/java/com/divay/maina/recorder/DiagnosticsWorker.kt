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
    private const val SYNC_WORK = "maina-diagnostics-sync"
    private const val RETENTION_WORK = "maina-diagnostics-retention"

    fun enqueue(context: Context, replace: Boolean = false) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresStorageNotLow(true)
            .build()
        val request = OneTimeWorkRequestBuilder<DiagnosticsWorker>()
            .setConstraints(constraints)
            .setInitialDelay(if (replace) 0 else 2, TimeUnit.SECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(SYNC_WORK)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            SYNC_WORK,
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
        val store = DiagnosticsStore(applicationContext)
        try {
            val config = store.config()
            if (!config.enabled || config.supabaseUrl.isBlank() || config.publishableKey.isBlank()) {
                return@withContext Result.success()
            }
            flushOutbox(store, config)
            val artifactFailures = uploadArtifacts(store, config)
            flushOutbox(store, config)
            deleteExpiredArtifacts(store, config)
            store.cleanupRetainedLocalSources()
            store.markUploadSuccess()
            if (artifactFailures) Result.retry() else Result.success()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            store.setLastError(error.message ?: error.javaClass.simpleName)
            Result.retry()
        } finally {
            store.close()
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
                    // 409 means a previous attempt completed but its response was lost.
                    if (response.code !in 200..299 && response.code != 409) {
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
                        "sourceExists" to File(artifact.sourcePath).isFile,
                        "sourceBytes" to File(artifact.sourcePath).takeIf { it.isFile }?.length(),
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

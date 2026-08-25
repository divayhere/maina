package com.divay.maina.recorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Debug
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max

internal class MainaPostProcessingService : Service() {
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "MainaPostProcessing").apply { isDaemon = true }
    }
    private val queuedMeetingIds = ConcurrentHashMap.newKeySet<String>()
    private val activeMeetingId = AtomicReference<String?>(null)
    private val latestStartId = AtomicInteger(0)
    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        const val CHANNEL_ID = "maina_post_processing"
        const val NOTIFICATION_ID = 7002
        const val ACTION_START = "com.divay.maina.recorder.START_NATIVE_POST_PROCESSING"
        const val ACTION_RESULT_CHANGED = "com.divay.maina.recorder.NATIVE_POST_PROCESSING_CHANGED"
        const val EXTRA_MEETING_ID = "meetingId"
        const val EXTRA_DIRECTORY = "directory"
        const val EXTRA_CAPTURE_ENDED_AT = "captureEndedAt"
        const val EXTRA_WALL_DURATION_MS = "wallDurationMs"
        const val EXTRA_AUDIO_DURATION_MS = "audioDurationMs"
        const val EXTRA_ROUTE_RESTART_COUNT = "routeRestartCount"
        const val EXTRA_CAPTURE_GAP_MS = "captureGapMs"
        const val EXTRA_MEETING_STARTED_AT = "meetingStartedAt"
        private const val WAKE_LOCK_TIMEOUT_MS = 6L * 60L * 60L * 1000L

        @Volatile private var currentlyProcessingMeetingId: String? = null

        fun isProcessing(meetingId: String): Boolean = currentlyProcessingMeetingId == meetingId
    }

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Maina transcription",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shows Maina's on-device transcription progress"
                setSound(null, null)
                enableVibration(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val meetingId = intent?.getStringExtra(EXTRA_MEETING_ID).orEmpty()
        val directory = intent?.getStringExtra(EXTRA_DIRECTORY).orEmpty()
        if (intent?.action != ACTION_START || meetingId.isBlank() || directory.isBlank()) {
            stopSelfResult(startId)
            return START_NOT_STICKY
        }

        latestStartId.set(startId)
        startForegroundCompat(buildNotification("Maina is transcribing", "Preparing saved audio"))
        if (!queuedMeetingIds.add(meetingId)) {
            startForegroundCompat(buildNotification("Maina is transcribing", "Already continuing this meeting"))
            return START_REDELIVER_INTENT
        }

        acquireWakeLock()
        executor.execute {
            activeMeetingId.set(meetingId)
            currentlyProcessingMeetingId = meetingId
            try {
                runPostProcessing(
                    meetingId = meetingId,
                    directory = directory,
                    captureEndedAt = intent.getLongExtra(EXTRA_CAPTURE_ENDED_AT, 0L).takeIf { it > 0L },
                    wallDurationMs = intent.getLongExtra(EXTRA_WALL_DURATION_MS, 0L),
                    audioDurationMs = intent.getLongExtra(EXTRA_AUDIO_DURATION_MS, 0L),
                    routeRestartCount = intent.getIntExtra(EXTRA_ROUTE_RESTART_COUNT, 0),
                    captureGapMs = intent.getLongExtra(EXTRA_CAPTURE_GAP_MS, 0L),
                    meetingStartedAt = intent.getLongExtra(EXTRA_MEETING_STARTED_AT, 0L),
                )
            } catch (error: Throwable) {
                val message = error.message ?: error.javaClass.simpleName
                Log.e("MainaPostProcessing", "Local transcription failed for meetingId=$meetingId", error)
                runCatching {
                    MainaPostProcessingOutbox.shared(applicationContext).defer(
                        meetingId, "Local transcription paused safely: $message",
                    )
                    MainaPostProcessingRecoveryScheduler.enqueue(applicationContext, meetingId)
                }
            } finally {
                queuedMeetingIds.remove(meetingId)
                activeMeetingId.set(null)
                currentlyProcessingMeetingId = null
                if (queuedMeetingIds.isEmpty()) {
                    releaseWakeLock()
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    } else {
                        @Suppress("DEPRECATION")
                        stopForeground(true)
                    }
                    stopSelfResult(latestStartId.get())
                } else {
                    updateProgress("Maina is transcribing", 0, 0)
                }
            }
        }
        return START_REDELIVER_INTENT
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        releaseWakeLock()
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        recordTimeoutAndStop()
    }

    private fun runPostProcessing(
        meetingId: String,
        directory: String,
        captureEndedAt: Long?,
        wallDurationMs: Long,
        audioDurationMs: Long,
        routeRestartCount: Int,
        captureGapMs: Long,
        meetingStartedAt: Long,
    ) {
        val inspection = waitForFinalizedChunks(directory)
        val chunkUris = inspection.finalizedUris
        if (chunkUris.isEmpty()) {
            MainaPostProcessingOutbox.shared(applicationContext).begin(
                meetingId, meetingStartedAt, captureEndedAt, 0L, 0L, 0, 0, routeRestartCount, captureGapMs,
            )
            MainaPostProcessingOutbox.shared(applicationContext).defer(
                meetingId,
                if (inspection.partialUris.isNotEmpty()) "Audio finalization is still incomplete; recovery audio was preserved."
                else "Native capture produced no finalized WAV chunks.",
            )
            return
        }

        val durations = chunkUris.map(MainaPostProcessingSupport::durationMs)
        val measuredAudioDurationMs = durations.sum()
        val effectiveAudioDurationMs = max(audioDurationMs, measuredAudioDurationMs)
        val effectiveWallDurationMs = when {
            wallDurationMs > 0L -> wallDurationMs
            effectiveAudioDurationMs > 0L -> effectiveAudioDurationMs
            else -> 0L
        }

        val windowPlans = durations.map(MainaPostProcessingSupport::planWindows)
        val totalWindows = windowPlans.sumOf { it.size }
        val outbox = MainaPostProcessingOutbox.shared(applicationContext)
        val start = outbox.begin(
            meetingId = meetingId,
            meetingStartedAt = meetingStartedAt,
            captureEndedAt = captureEndedAt,
            durationMs = effectiveWallDurationMs,
            audioDurationMs = effectiveAudioDurationMs,
            segmentCount = chunkUris.size,
            windowCount = totalWindows,
            routeRestartCount = routeRestartCount,
            captureGapMs = captureGapMs,
        )
        if (start.alreadyTerminal) {
            Log.i("MainaPostProcessing", "Terminal outbox run already exists for meetingId=$meetingId")
            notifyResultChanged(meetingId, "terminal")
            return
        }
        Log.i(
            "MainaPostProcessing",
            "Starting local transcription meetingId=$meetingId chunks=${chunkUris.size} totalWindows=$totalWindows wallDurationMs=$effectiveWallDurationMs audioDurationMs=$effectiveAudioDurationMs routeRestarts=$routeRestartCount captureGapMs=$captureGapMs",
        )
        val asr = MainaQwenAsr(applicationContext)
        var previousText = ""
        var completedWindows = start.completedWindowKeys.size
        var failedWindows = 0
        var processedSegments = 0
        var lastError: String? = null
        var chunkCursorAt = meetingStartedAt
        var windowOrdinal = 0

        updateProgress("Scanning the meeting", completedWindows, totalWindows)

        try {
            chunkUris.forEachIndexed { chunkIndex, uri ->
                val chunkDurationMs = durations.getOrNull(chunkIndex) ?: 0L
                val windows = windowPlans.getOrNull(chunkIndex).orEmpty()
                Log.i(
                    "MainaPostProcessing",
                    "Chunk start meetingId=$meetingId chunkIndex=$chunkIndex chunkDurationMs=$chunkDurationMs windows=${windows.size} uri=$uri",
                )
                windows.forEachIndexed { windowIndex, window ->
                    val baseSequence = windowOrdinal * 2
                    windowOrdinal += 1
                    val windowKey = MainaPostProcessingOutbox.windowKey(chunkIndex, windowIndex)
                    if (windowKey in start.completedWindowKeys) {
                        updateProgress("Writing the transcript", completedWindows + failedWindows, totalWindows)
                        return@forEachIndexed
                    }
                    if (Thread.currentThread().isInterrupted) {
                        throw InterruptedException("Capture preempted local transcription at a durable window boundary")
                    }
                    Log.i(
                        "MainaPostProcessing",
                        "Window start meetingId=$meetingId chunkIndex=$chunkIndex windowIndex=$windowIndex startMs=${window.startMs} endMs=${window.endMs}",
                    )
                    outbox.clearWindowBlocks(meetingId, start.runId, baseSequence)
                    if (previousText.isBlank() && start.resumed) {
                        previousText = outbox.lastBlockTextBefore(meetingId, start.runId, baseSequence)
                    }
                    try {
                        val outcome = decodeWindowWithRecovery(asr, uri, window)
                        if (Thread.currentThread().isInterrupted) {
                            throw InterruptedException("Capture preempted local transcription at a durable window boundary")
                        }
                        if (!outcome.complete) {
                            failedWindows += 1
                            lastError = outcome.error ?: "Local transcription coverage is incomplete."
                            Log.w(
                                "MainaPostProcessing",
                                "Window remained incomplete after bounded recovery meetingId=$meetingId chunkIndex=$chunkIndex windowIndex=$windowIndex error=$lastError",
                            )
                        } else {
                            completedWindows += 1
                            Log.i(
                                "MainaPostProcessing",
                                "Window done meetingId=$meetingId chunkIndex=$chunkIndex windowIndex=$windowIndex attempts=${outcome.pieces.size} processingMs=${outcome.pieces.sumOf { it.processingMs }}",
                            )
                        }
                        outcome.pieces.take(2).forEachIndexed { pieceIndex, result ->
                            val rawText = result.text.trim()
                            val text = MainaPostProcessingSupport.removeExactOverlap(previousText, rawText)
                            if (text.isNotBlank()) {
                                outbox.appendBlock(
                                    meetingId = meetingId,
                                    runId = start.runId,
                                    sequence = baseSequence + pieceIndex,
                                    segmentIndex = chunkIndex,
                                    startedAt = chunkCursorAt + result.windowStartMs,
                                    endedAt = chunkCursorAt + result.windowEndMs,
                                    language = result.language.takeIf { it.isNotBlank() } ?: "auto",
                                    text = text,
                                )
                            }
                            if (rawText.isNotBlank()) previousText = rawText
                        }
                        outbox.markWindow(
                            meetingId,
                            start.runId,
                            chunkIndex,
                            windowIndex,
                            outcome.complete,
                            outcome.error,
                            windowEvidence(outcome, outcome.error),
                        )
                    } catch (error: Throwable) {
                        if (error is InterruptedException) throw error
                        failedWindows += 1
                        lastError = error.message ?: error.javaClass.simpleName
                        outbox.markWindow(
                            meetingId,
                            start.runId,
                            chunkIndex,
                            windowIndex,
                            false,
                            lastError,
                            failureEvidence(lastError),
                        )
                        Log.w(
                            "MainaPostProcessing",
                            "Window failed meetingId=$meetingId chunkIndex=$chunkIndex windowIndex=$windowIndex message=${lastError}",
                            error,
                        )
                    }
                    outbox.updateProgress(
                        meetingId = meetingId,
                        processedSegments = processedSegments,
                        completedWindows = completedWindows,
                        failedWindows = failedWindows,
                        lastError = lastError,
                    )
                    notifyResultChanged(meetingId, MainaPostProcessingOutbox.STATE_RUNNING)
                    updateProgress("Writing the transcript", completedWindows + failedWindows, totalWindows)
                }
                processedSegments = chunkIndex + 1
                Log.i(
                    "MainaPostProcessing",
                    "Chunk finished meetingId=$meetingId chunkIndex=$chunkIndex processedSegments=$processedSegments completedWindows=$completedWindows failedWindows=$failedWindows",
                )
                outbox.updateProgress(
                    meetingId = meetingId,
                    processedSegments = processedSegments,
                    completedWindows = completedWindows,
                    failedWindows = failedWindows,
                    lastError = lastError,
                )
                chunkCursorAt += chunkDurationMs
            }
        } finally {
            asr.release()
        }

        val hasTranscript = outbox.lastBlockTextBefore(meetingId, start.runId, Int.MAX_VALUE).isNotBlank()
        val coverageComplete = MainaPostProcessingSupport.coverageComplete(
            totalWindows,
            completedWindows,
            failedWindows,
        )
        val finalError = if (coverageComplete) null else (lastError ?: "Local transcription coverage is incomplete.")
        outbox.finish(meetingId, processedSegments, completedWindows, failedWindows, finalError)
        Log.i(
            "MainaPostProcessing",
            "Finished local transcription meetingId=$meetingId hasTranscript=$hasTranscript processedSegments=$processedSegments completedWindows=$completedWindows failedWindows=$failedWindows finalError=${finalError ?: "none"}",
        )
        notifyResultChanged(
            meetingId,
            if (coverageComplete) MainaPostProcessingOutbox.STATE_COMPLETE else MainaPostProcessingOutbox.STATE_PARTIAL,
        )
        updateProgress(
            if (hasTranscript) "Transcript ready" else "Transcript saved",
            completedWindows + failedWindows,
            totalWindows,
        )
    }

    private data class WindowDecodeOutcome(
        val pieces: List<MainaQwenAsr.Result>,
        val complete: Boolean,
        val error: String?,
    )

    private fun decodeWindowWithRecovery(
        asr: MainaQwenAsr,
        uri: String,
        window: AsrWindow,
    ): WindowDecodeOutcome {
        val first = asr.transcribe(uri, window.startMs, window.endMs)
        if (!isSuspicious(first)) return WindowDecodeOutcome(listOf(first), true, null)

        val retries = MainaPostProcessingSupport.splitForRetry(window)
        if (retries.isEmpty()) {
            return WindowDecodeOutcome(listOf(first), false, suspiciousReason(first))
        }

        Log.w(
            "MainaPostProcessing",
            "Retrying suspicious ASR window as ${retries.size} bounded overlapping pieces startMs=${window.startMs} endMs=${window.endMs}",
        )
        val pieces = mutableListOf<MainaQwenAsr.Result>()
        var error: String? = null
        retries.forEach { retry ->
            try {
                val result = asr.transcribe(uri, retry.startMs, retry.endMs)
                pieces += result
                if (isSuspicious(result)) error = suspiciousReason(result)
            } catch (cause: Throwable) {
                if (cause is InterruptedException) throw cause
                error = cause.message ?: cause.javaClass.simpleName
            }
        }
        return WindowDecodeOutcome(
            pieces = pieces,
            complete = pieces.size == retries.size && error == null,
            error = error,
        )
    }

    private fun isSuspicious(result: MainaQwenAsr.Result): Boolean =
        (result.speechExpected && result.text.isBlank()) || result.truncationSuspected

    private fun suspiciousReason(result: MainaQwenAsr.Result): String = when {
        result.truncationSuspected -> "ASR output limit reached during local transcription."
        else -> "Speech-like audio returned no text during local transcription."
    }

    private fun windowEvidence(
        outcome: WindowDecodeOutcome,
        retryReason: String?,
    ): MainaPostProcessingOutbox.WindowEvidence {
        val pieces = outcome.pieces
        return MainaPostProcessingOutbox.WindowEvidence(
            processingMs = pieces.sumOf { it.processingMs },
            tokenCount = pieces.sumOf { it.tokenCount },
            truncationSuspected = pieces.any { it.truncationSuspected },
            retryReason = retryReason,
            thermalStatus = currentThermalStatus(),
            memoryPssKb = currentProcessPssKb(),
            rmsDbfs = pieces.minOfOrNull { it.rmsDbfs },
            peakDbfs = pieces.maxOfOrNull { it.peakDbfs },
        )
    }

    private fun failureEvidence(error: String?): MainaPostProcessingOutbox.WindowEvidence =
        MainaPostProcessingOutbox.WindowEvidence(
            processingMs = 0L,
            tokenCount = 0,
            truncationSuspected = false,
            retryReason = error,
            thermalStatus = currentThermalStatus(),
            memoryPssKb = currentProcessPssKb(),
            rmsDbfs = null,
            peakDbfs = null,
        )

    private fun currentThermalStatus(): Int? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        getSystemService(PowerManager::class.java)?.currentThermalStatus
    } else {
        null
    }

    private fun currentProcessPssKb(): Int {
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        return info.totalPss
    }

    private fun notifyResultChanged(meetingId: String, state: String) {
        sendBroadcast(
            Intent(ACTION_RESULT_CHANGED)
                .setPackage(packageName)
                .putExtra(EXTRA_MEETING_ID, meetingId)
                .putExtra("state", state),
        )
    }

    private fun waitForFinalizedChunks(directory: String): MainaNativeAudioCapture.DirectoryInspection {
        repeat(MainaPostProcessingStartPolicy.finalizedChunkAttempts()) { attempt ->
            val inspection = MainaNativeAudioCapture.inspectDirectory(directory, true)
            if (inspection.finalizedUris.isNotEmpty()) return inspection
            if (inspection.partialUris.isEmpty()) return inspection
            if (attempt + 1 < MainaPostProcessingStartPolicy.finalizedChunkAttempts()) {
                updateProgress("Preparing saved audio", attempt + 1, MainaPostProcessingStartPolicy.finalizedChunkAttempts())
                Thread.sleep(MainaPostProcessingStartPolicy.finalizedChunkDelayMs(attempt))
            }
        }
        return MainaNativeAudioCapture.inspectDirectory(directory, true)
    }

    private fun buildNotification(title: String, detail: String, progress: Int? = null, max: Int? = null): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(detail)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pendingIntent)
        if (progress != null && max != null && max > 0) {
            builder.setProgress(max, progress.coerceIn(0, max), false)
        }
        return builder.build()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= 35) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val powerManager = getSystemService(PowerManager::class.java)
        wakeLock = powerManager
            ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:MainaPostProcessing")
            ?.apply {
                setReferenceCounted(false)
                acquire(WAKE_LOCK_TIMEOUT_MS)
            }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { lock ->
            if (lock.isHeld) {
                runCatching { lock.release() }
            }
        }
        wakeLock = null
    }

    private fun recordTimeoutAndStop() {
        val affectedMeetings = queuedMeetingIds.toList()
        Log.w(
            "MainaPostProcessing",
            "Android media processing time limit reached; Maina will resume on next foreground sync. meetingId=${activeMeetingId.get()}",
        )
        affectedMeetings.forEach { meetingId ->
            runCatching {
                MainaPostProcessingOutbox.shared(applicationContext).defer(
                    meetingId,
                    "Android paused local transcription at its background-processing limit. Reopen Maina to continue.",
                )
                MainaPostProcessingRecoveryScheduler.enqueue(applicationContext, meetingId)
            }
        }
        queuedMeetingIds.clear()
        executor.shutdownNow()
        releaseWakeLock()
        stopSelf()
    }

    private fun updateProgress(title: String, progress: Int, max: Int) {
        val detail = if (max > 0) "$progress of $max audio windows processed" else "Continuing on-device transcription"
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(title, detail, progress, max))
    }
}

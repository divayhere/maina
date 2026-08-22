package com.divay.maina.recorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
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
        if (start.alreadyComplete) {
            Log.i("MainaPostProcessing", "Completed outbox run already exists for meetingId=$meetingId")
            return
        }
        Log.i(
            "MainaPostProcessing",
            "Starting local transcription meetingId=$meetingId chunks=${chunkUris.size} totalWindows=$totalWindows wallDurationMs=$effectiveWallDurationMs audioDurationMs=$effectiveAudioDurationMs routeRestarts=$routeRestartCount captureGapMs=$captureGapMs",
        )
        val asr = MainaQwenAsr(applicationContext)
        var previousText = ""
        var completedWindows = 0
        var failedWindows = 0
        var processedSegments = 0
        var sequence = 0
        var lastError: String? = null
        var chunkCursorAt = meetingStartedAt

        updateProgress("Scanning the meeting", completedWindows, totalWindows)

        try {
            chunkUris.forEachIndexed { chunkIndex, uri ->
                val chunkDurationMs = durations.getOrNull(chunkIndex) ?: 0L
                val windows = windowPlans.getOrNull(chunkIndex).orEmpty()
                Log.i(
                    "MainaPostProcessing",
                    "Chunk start meetingId=$meetingId chunkIndex=$chunkIndex chunkDurationMs=$chunkDurationMs windows=${windows.size} uri=$uri",
                )
                windows.forEach { window ->
                    Log.i(
                        "MainaPostProcessing",
                        "Window start meetingId=$meetingId chunkIndex=$chunkIndex windowIndex=${window.index} startMs=${window.startMs} endMs=${window.endMs}",
                    )
                    try {
                        val result = asr.transcribe(uri, window.startMs, window.endMs)
                        val rawText = result.text.trim()
                        val text = MainaPostProcessingSupport.removeExactOverlap(previousText, rawText)
                        val suspicious = (result.speechExpected && rawText.isBlank()) || result.truncationSuspected
                        if (suspicious) {
                            failedWindows += 1
                            lastError = if (result.truncationSuspected) {
                                "ASR output limit reached during local transcription."
                            } else {
                                "Speech-like audio returned no text during local transcription."
                            }
                            Log.w(
                                "MainaPostProcessing",
                                "Window suspicious meetingId=$meetingId chunkIndex=$chunkIndex windowIndex=${window.index} speechExpected=${result.speechExpected} truncationSuspected=${result.truncationSuspected} language=${result.language} processingMs=${result.processingMs}",
                            )
                        } else {
                            completedWindows += 1
                            Log.i(
                                "MainaPostProcessing",
                                "Window done meetingId=$meetingId chunkIndex=$chunkIndex windowIndex=${window.index} language=${result.language} processingMs=${result.processingMs} chars=${text.length}",
                            )
                        }
                        if (text.isNotBlank()) {
                            outbox.appendBlock(
                                meetingId = meetingId,
                                runId = start.runId,
                                sequence = sequence++,
                                segmentIndex = chunkIndex,
                                startedAt = chunkCursorAt + window.startMs,
                                endedAt = chunkCursorAt + window.endMs,
                                language = result.language.takeIf { it.isNotBlank() } ?: "auto",
                                text = text,
                            )
                            previousText = rawText
                        }
                    } catch (error: Throwable) {
                        failedWindows += 1
                        lastError = error.message ?: error.javaClass.simpleName
                        Log.w(
                            "MainaPostProcessing",
                            "Window failed meetingId=$meetingId chunkIndex=$chunkIndex windowIndex=${window.index} message=${lastError}",
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

        val hasTranscript = sequence > 0
        val coverageComplete = totalWindows > 0 && failedWindows == 0 && completedWindows == totalWindows
        val finalError = if (coverageComplete) null else (lastError ?: "Local transcription coverage is incomplete.")
        outbox.complete(meetingId, processedSegments, completedWindows, failedWindows, finalError)
        Log.i(
            "MainaPostProcessing",
            "Finished local transcription meetingId=$meetingId hasTranscript=$hasTranscript processedSegments=$processedSegments completedWindows=$completedWindows failedWindows=$failedWindows finalError=${finalError ?: "none"}",
        )
        updateProgress(
            if (hasTranscript) "Transcript ready" else "Transcript saved",
            completedWindows + failedWindows,
            totalWindows,
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

package com.divay.maina.recorder

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

/**
 * Durable recovery signalling for a deferred ASR run.
 *
 * A Worker makes one controlled attempt to restart the media-processing
 * foreground service. Android can reject a background foreground-service start,
 * so rejection is logged and retried with WorkManager backoff rather than
 * turning a safe checkpoint into a crash loop. START_REDELIVER_INTENT covers
 * permitted service process death; the notification remains the final safe
 * fallback after the bounded recovery budget is exhausted.
 */
internal object MainaPostProcessingRecoveryScheduler {
    private const val CHANNEL_ID = "maina_asr_recovery"
    private const val NOTIFICATION_BASE_ID = 7100
    const val EXTRA_MEETING_ID = "meetingId"
    const val EXTRA_RECOVERY_ROUND = "recoveryRound"

    fun enqueue(context: Context, meetingId: String, requestedRecoveryRound: Int? = null) {
        if (meetingId.isBlank()) return
        val recoveryRound = requestedRecoveryRound
            ?: ((MainaPostProcessingOutbox.shared(context.applicationContext).read(meetingId)?.get("recoveryRounds") as? Int) ?: 0)
        val builder = OneTimeWorkRequestBuilder<MainaPostProcessingRecoveryWorker>()
            .setInputData(workDataOf(
                EXTRA_MEETING_ID to meetingId,
                EXTRA_RECOVERY_ROUND to recoveryRound,
            ))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag("maina-asr-recovery")
        val delayMs = MainaPostProcessingRecoveryPolicy.scheduledRetryDelayMs(recoveryRound)
        if (delayMs > 0L) builder.setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
        val request = builder.build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            MainaPostProcessingRecoveryPolicy.uniqueWorkName(meetingId, recoveryRound),
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    fun notifyResume(context: Context, meetingId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Maina transcription recovery",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = "Shows when saved audio needs Maina to resume local transcription" },
            )
        }
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            ?: return
        val pending = PendingIntent.getActivity(
            context,
            meetingId.hashCode(),
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = androidx.core.app.NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Maina paused local transcription")
            .setContentText("Open Maina to continue from the saved checkpoint.")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        manager.notify(NOTIFICATION_BASE_ID + (meetingId.hashCode() and 0x0fff), notification)
    }
}

internal class MainaPostProcessingRecoveryWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val meetingId = inputData.getString(MainaPostProcessingRecoveryScheduler.EXTRA_MEETING_ID).orEmpty()
        val scheduledRecoveryRound = inputData.getInt(MainaPostProcessingRecoveryScheduler.EXTRA_RECOVERY_ROUND, 0)
        if (meetingId.isBlank()) return Result.failure()
        // A fresh meeting always wins over deferred ASR. The recording service
        // checkpoints the old ASR at a window boundary; WorkManager will retry
        // this unique recovery request later instead of competing for CPU/RAM.
        if (MainaRecordingService.captureState != "idle") return Result.retry()
        val run = MainaPostProcessingOutbox.shared(applicationContext).read(meetingId) ?: return Result.success()
        return when (run["state"] as? String) {
            MainaPostProcessingOutbox.STATE_COMPLETE,
            -> Result.success()
            MainaPostProcessingOutbox.STATE_RUNNING -> Result.retry()
            else -> {
                val recoveryRounds = run["recoveryRounds"] as? Int ?: 0
                // Foreground reconciliation may have already advanced this
                // meeting. A stale delayed request must not consume another
                // retry round or collapse the intended 20/60 minute spacing.
                if (!MainaPostProcessingRecoveryPolicy.isCurrentScheduledRound(scheduledRecoveryRound, recoveryRounds)) {
                    return Result.success()
                }
                val directory = run["captureDirectory"] as? String
                if (directory.isNullOrBlank() || !MainaPostProcessingRecoveryPolicy.shouldScheduleAnotherRound(recoveryRounds)) {
                    MainaPostProcessingRecoveryScheduler.notifyResume(applicationContext, meetingId)
                    return Result.success()
                }
                val intent = Intent(applicationContext, MainaPostProcessingService::class.java).apply {
                    action = MainaPostProcessingService.ACTION_START
                    putExtra(MainaPostProcessingService.EXTRA_MEETING_ID, meetingId)
                    putExtra(MainaPostProcessingService.EXTRA_DIRECTORY, directory)
                    putExtra(MainaPostProcessingService.EXTRA_FORCE_RETRY, true)
                    (run["meetingStartedAt"] as? Long)?.let { putExtra(MainaPostProcessingService.EXTRA_MEETING_STARTED_AT, it) }
                    (run["captureEndedAt"] as? Long)?.let { putExtra(MainaPostProcessingService.EXTRA_CAPTURE_ENDED_AT, it) }
                    (run["durationMs"] as? Long)?.let { putExtra(MainaPostProcessingService.EXTRA_WALL_DURATION_MS, it) }
                    (run["audioDurationMs"] as? Long)?.let { putExtra(MainaPostProcessingService.EXTRA_AUDIO_DURATION_MS, it) }
                    (run["routeRestartCount"] as? Int)?.let { putExtra(MainaPostProcessingService.EXTRA_ROUTE_RESTART_COUNT, it) }
                    (run["captureGapMs"] as? Long)?.let { putExtra(MainaPostProcessingService.EXTRA_CAPTURE_GAP_MS, it) }
                }
                try {
                    ContextCompat.startForegroundService(applicationContext, intent)
                    Result.success()
                } catch (error: Throwable) {
                    // Some Android states forbid a foreground-service start from
                    // background. WorkManager backs off and Maina's foreground
                    // reconciliation still resumes safely at the next launch.
                    Log.w(
                        "MainaPostProcessing",
                        "Deferred local transcription restart was denied; retrying with WorkManager backoff.",
                        error,
                    )
                    Result.retry()
                }
            }
        }
    }
}

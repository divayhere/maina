package com.divay.maina.recorder

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
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
 * A Worker does not restart the media-processing foreground service from the
 * background: Android can reject that start and turn a safe checkpoint into a
 * crash loop. START_REDELIVER_INTENT covers permitted service process death;
 * this worker preserves one named recovery request and provides one actionable
 * foreground-resume notification after a timeout or controlled defer.
 */
internal object MainaPostProcessingRecoveryScheduler {
    private const val CHANNEL_ID = "maina_asr_recovery"
    private const val NOTIFICATION_BASE_ID = 7100
    const val EXTRA_MEETING_ID = "meetingId"

    fun enqueue(context: Context, meetingId: String) {
        if (meetingId.isBlank()) return
        val request = OneTimeWorkRequestBuilder<MainaPostProcessingRecoveryWorker>()
            .setInputData(workDataOf(EXTRA_MEETING_ID to meetingId))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag("maina-asr-recovery")
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            "maina-asr-recovery-$meetingId",
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
        if (meetingId.isBlank()) return Result.failure()
        val run = MainaPostProcessingOutbox.shared(applicationContext).read(meetingId) ?: return Result.success()
        return when (run["state"] as? String) {
            MainaPostProcessingOutbox.STATE_COMPLETE,
            MainaPostProcessingOutbox.STATE_PARTIAL,
            -> Result.success()
            MainaPostProcessingOutbox.STATE_RUNNING -> Result.retry()
            else -> {
                MainaPostProcessingRecoveryScheduler.notifyResume(applicationContext, meetingId)
                Result.success()
            }
        }
    }
}

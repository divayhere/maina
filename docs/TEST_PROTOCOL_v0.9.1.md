# Maina v0.9.1 Pixel acceptance protocol

Keep the phone connected to power for the long test. Do not uninstall Maina; install the update over the existing app so meetings remain intact.

## A. Readiness and remote mapping — 3 minutes

1. Open Maina once and allow microphone and notification permissions.
2. Open Settings. Confirm `Maina: Ready · armed` and `Notification: Allowed`.
3. Wake/pair the POPIO. Confirm it appears under Button, or press once and confirm Last press changes.
4. With Maina visible and idle, press the primary button once. Recording should begin after the deliberate ~0.4 s double-click window.
5. Press primary once: pause. Wait five seconds and speak; paused speech must not enter the transcript.
6. Press primary once: resume.
7. Press the secondary button once: stop and save.

## B. Locked-screen control — 5 minutes

1. Open Key Mapper 4.x and enable its required Accessibility service and **Expert Mode**. Record the POPIO trigger while Expert Mode is active; the standard accessibility-only path is not sufficient for reliable screen-off capture.
2. Create a primary-button mapping whose action broadcasts intent action `com.divay.maina.action.TOGGLE` to package `com.divay.maina`.
3. Create a secondary-button mapping whose action broadcasts intent action `com.divay.maina.action.STOP` to package `com.divay.maina`.
4. Return to Maina Settings and confirm `Ready · armed`, then lock the phone.
5. Press primary to start, primary to pause, primary to resume, then secondary to stop and save—all without unlocking.
6. Unlock and confirm one meeting—not duplicates—was saved. In Maina Settings, confirm Last press shows the expected command/device.

If Expert Mode is not running after a reboot, start it again before relying on screen-off POPIO control. This dependency is shown as a test gate rather than hidden as an app guarantee.

## C. Hollyland failover — 6 minutes

1. Connect the Hollyland receiver and begin speaking continuously.
2. At one minute, remove the USB-C receiver while continuing to speak for 30 seconds.
3. Continue on the phone microphone for another minute.
4. Reconnect Hollyland and keep speaking for another minute.
5. Stop and save.
6. Expected: the meeting contains multiple audio segments, no crash, and words from before/during/after both route changes. A short transition gap is acceptable; a silent remainder is not.

## D. Process-death recovery — 4 minutes

1. Start recording and speak for 90 seconds.
2. From ADB, the maintainer force-stops the app without pressing Stop.
3. Reopen Maina.
4. Expected: the meeting is shown as Recovered, its WAV is repairable/playable, and the prior checkpointed transcript remains.

## E. Soak test — 3 hours

1. Start with Hollyland, lock the screen and keep the phone charging.
2. Include speech, silence, Hindi, English and natural switching.
3. Perform at least two pauses and resumes, one Hollyland disconnect and reconnect, and one airplane-mode period.
4. Stop normally.
5. Acceptance: saved audio duration is at least 99% of active wall time excluding pauses; no missing segment; no unrecovered crash; Supabase has the run, events, transcript and every audio artifact.

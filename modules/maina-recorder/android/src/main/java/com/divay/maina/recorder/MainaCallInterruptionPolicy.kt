package com.divay.maina.recorder

internal object MainaCallInterruptionPolicy {
    fun communicationActive(audioMode: Int, clientSilenced: Boolean): Boolean =
        clientSilenced || audioMode == 2 || audioMode == 3

    fun shouldPause(captureState: String, alreadyPausedForCall: Boolean, communicationActive: Boolean): Boolean =
        captureState == "recording" && !alreadyPausedForCall && communicationActive

    fun shouldResume(captureState: String, pausedForCall: Boolean, communicationActive: Boolean): Boolean =
        captureState == "recording" && pausedForCall && !communicationActive
}

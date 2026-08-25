package com.divay.maina.recorder

/**
 * Device-qualified Qwen limits. Keeping them outside the recognizer lets the
 * native unit suite protect against accidental "just increase the limit"
 * changes that previously caused pathological memory and latency on Pixel.
 */
internal object MainaQwenAsrPolicy {
    const val maxTotalLen = 512
    const val maxNewTokens = 128
    const val inferenceThreads = 2
    private const val tokenTruncationMargin = 4
    private const val speechExpectedRmsDbfs = -55.0

    fun isTruncationSuspected(tokenCount: Int): Boolean =
        tokenCount >= maxNewTokens - tokenTruncationMargin

    fun isSpeechExpected(rmsDbfs: Double): Boolean = rmsDbfs >= speechExpectedRmsDbfs
}

package com.divay.maina.recorder

/**
 * Device-qualified Qwen limits. Keeping them outside the recognizer lets the
 * native unit suite protect against accidental "just increase the limit"
 * changes that previously caused pathological memory and latency on Pixel.
 */
internal object MainaQwenAsrPolicy {
    const val maxTotalLen = 512
    /** Normal mobile decode budget. This remains the common, low-heat path. */
    const val maxNewTokens = 128
    /**
     * A single bounded retry budget for a genuinely token-capped window. It is
     * intentionally not the default: most meeting windows do not need it, and
     * raising every decode budget unnecessarily increases memory and latency.
     */
    const val recoveryMaxNewTokens = 256
    const val inferenceThreads = 2
    private const val speechExpectedRmsDbfs = -55.0

    /** sherpa/Qwen reports an exact cap when generated tokens reach the budget. */
    fun isTruncationSuspected(tokenCount: Int, maxNewTokens: Int): Boolean =
        tokenCount >= maxNewTokens

    fun canUseRecoveryBudget(maxNewTokens: Int): Boolean =
        maxNewTokens < recoveryMaxNewTokens

    fun isSpeechExpected(rmsDbfs: Double): Boolean = rmsDbfs >= speechExpectedRmsDbfs
}

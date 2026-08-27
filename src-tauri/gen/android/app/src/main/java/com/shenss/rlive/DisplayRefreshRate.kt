package com.shenss.rlive

private const val MAX_ANIMATION_REFRESH_RATE_HZ = 120.0f
private const val HIGH_REFRESH_RATE_HZ = 90.0f
private const val REFRESH_RATE_TOLERANCE_HZ = 0.5f

/**
 * 优先取 120 Hz 以内最快的高刷新率模式。面板只暴露 60 和一个 120 Hz
 * 以上的更快模式时，取更快者而不是退回 60 Hz。
 */
internal fun preferredAnimationRefreshRate(refreshRates: Iterable<Float>): Float? {
  val validRates = refreshRates.filter { it.isFinite() && it > 0.0f }
  if (validRates.isEmpty()) {
    return null
  }

  val fastestRate = validRates.maxOrNull() ?: return null
  val fastestCappedRate = validRates
    .filter { it <= MAX_ANIMATION_REFRESH_RATE_HZ + REFRESH_RATE_TOLERANCE_HZ }
    .maxOrNull()

  return if (fastestCappedRate != null && fastestCappedRate >= HIGH_REFRESH_RATE_HZ) {
    fastestCappedRate
  } else {
    fastestRate
  }
}

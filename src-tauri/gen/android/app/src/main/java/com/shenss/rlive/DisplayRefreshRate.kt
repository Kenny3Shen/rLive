package com.shenss.rlive

private const val MAX_ANIMATION_REFRESH_RATE_HZ = 120.0f
private const val HIGH_REFRESH_RATE_HZ = 90.0f
private const val REFRESH_RATE_TOLERANCE_HZ = 0.5f

/**
 * Prefer the fastest high-refresh mode up to 120 Hz. A panel that only exposes
 * 60 and a faster mode above 120 Hz uses the faster mode instead of regressing
 * to 60 Hz.
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

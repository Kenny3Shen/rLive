package com.shenss.rlive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DisplayRefreshRateTest {
  @Test
  fun prefers120HzOverHigherPanelModes() {
    assertEquals(
      120.0f,
      preferredAnimationRefreshRate(listOf(60.0f, 90.0f, 120.0f, 144.0f)) ?: 0.0f,
      0.01f,
    )
  }

  @Test
  fun usesTheAvailable90HzMode() {
    assertEquals(90.0f, preferredAnimationRefreshRate(listOf(60.0f, 90.0f)) ?: 0.0f, 0.01f)
  }

  @Test
  fun doesNotChoose60HzWhenTheOnlyHighModeExceeds120Hz() {
    assertEquals(144.0f, preferredAnimationRefreshRate(listOf(60.0f, 144.0f)) ?: 0.0f, 0.01f)
  }

  @Test
  fun rejectsInvalidRates() {
    assertNull(preferredAnimationRefreshRate(listOf(Float.NaN, Float.POSITIVE_INFINITY, 0.0f)))
  }
}

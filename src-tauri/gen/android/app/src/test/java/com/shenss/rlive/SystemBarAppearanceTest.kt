package com.shenss.rlive

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemBarAppearanceTest {
  @Test
  fun immersiveFullscreenForcesWhiteIconsRegardlessOfTheme() {
    // 全屏画面为黑：无论应用/系统主题如何，图标都必须是白色（非亮色外观）。
    assertFalse(appearanceLightSystemBars(darkSurface = false, immersive = true, systemNightMode = false))
    assertFalse(appearanceLightSystemBars(darkSurface = true, immersive = true, systemNightMode = true))
  }

  @Test
  fun appThemeDrivesIconsOutsideFullscreen() {
    // 应用深色表面 → 白图标。
    assertFalse(appearanceLightSystemBars(darkSurface = true, immersive = false, systemNightMode = false))
    // 应用浅色表面 → 深图标，即使系统当前是深色。
    assertTrue(appearanceLightSystemBars(darkSurface = false, immersive = false, systemNightMode = true))
  }

  @Test
  fun fallsBackToSystemNightModeBeforeFirstSync() {
    // 首启尚未收到前端值时，保持 enableEdgeToEdge() 的默认判定。
    assertFalse(appearanceLightSystemBars(darkSurface = null, immersive = false, systemNightMode = true))
    assertTrue(appearanceLightSystemBars(darkSurface = null, immersive = false, systemNightMode = false))
  }
}

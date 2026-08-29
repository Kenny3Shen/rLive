package com.shenss.rlive

/**
 * 解析系统栏图标应为「亮色外观」（深色图标，适合浅色表面）还是
 * 非亮色外观（白色图标，适合深色表面）。纯函数，规则集中一处便于单测。
 *
 * 优先级：
 * 1. 沉浸式全屏（页面内 fixed 层或视频 custom view）—— 画面为黑，
 *    透明滑出的临时系统栏压在黑色上，图标必须是白色；
 * 2. 应用主题 —— 前端下发的 `darkSurface` 直接决定；
 * 3. 无应用值（首启尚未收到前端调用）—— 回落系统 night mode，
 *    与 `enableEdgeToEdge()` 的默认判定保持一致。
 */
internal fun appearanceLightSystemBars(
  darkSurface: Boolean?,
  immersive: Boolean,
  systemNightMode: Boolean,
): Boolean = when {
  immersive -> false
  darkSurface != null -> !darkSurface
  else -> !systemNightMode
}

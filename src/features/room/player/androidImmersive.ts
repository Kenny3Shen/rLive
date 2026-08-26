/**
 * 不使用 WebView 的 HTML Fullscreen API 实现 Android 全屏。
 *
 * 过去点全屏会调用 `stage.requestFullscreen()`。Chromium 应答时会请求
 * `WebChromeClient.onShowCustomView` 提供容器并*把渲染内容重新挂载到一个全新
 * 的 View 上*。这是一次渲染表面交接：旧 WebView 在新 View 产出第一帧之前就停止
 * 绘制，于是屏幕连续黑掉数帧，画面要等新表面绘制后才出现。同帧 CSS 无法补救，
 * 因为问题帧属于一个尚未绘制过的 View。
 *
 * 桌面 Tauri 早就因为另一个原因避开浏览器全屏（WebView2 无法让最大化窗口越过
 * 工作区），改用页面内固定层铺满屏幕 —— 即舞台上的 `data-fullscreen="true"`。
 * 那条路径从不交接表面，因此从不黑帧。Android 复用它：舞台成为固定层，
 * 系统栏经原生插件隐藏，
 * 而不是作为 custom view 的副作用。
 *
 * Back 无需额外处理。`AndroidBackNavigator` 已把系统 Back 转换为可取消的
 * `rlive:android-back` 事件，而 `PlayerPane` 在 `mode === "fullscreen"` 时取消它
 * 并执行正常退出 —— 按正确顺序恢复系统栏、释放方向锁并撤掉固定层。
 * 改为在 Activity 中消费 Back 会抢占该事件，
 * 连带带走浮层监听器（HUD 菜单、音量面板）。
 *
 * 非 Tauri 的移动浏览器保留真正的 Fullscreen API —— 那里没有原生桥，
 * 普通的 `position: fixed` 层也藏不住浏览器自身 chrome。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getClientPlatform } from "@/shared/clientPlatform";
import { supportsAndroidNativePlayerControls } from "./androidPlayerControls";

const NATIVE_SET_IMMERSIVE = "android_player_controls_set_immersive";

type NativeImmersiveInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 该客户端是否应以页面内固定层铺满屏幕而不是请求浏览器全屏。
 *
 * 保持为两个输入的纯函数，使两条分支无需 WebView 即可测试。
 */
export function usesInPageFullscreen({
  tauriRuntime,
  platform,
}: {
  tauriRuntime: boolean;
  platform: ReturnType<typeof getClientPlatform>;
}): boolean {
  return supportsAndroidNativePlayerControls({ tauriRuntime, platform });
}

export function runningOnAndroidTauri(): boolean {
  return usesInPageFullscreen({ tauriRuntime: isTauri(), platform: getClientPlatform() });
}

/**
 * 为页面内全屏播放器隐藏或恢复 Android 系统栏。
 *
 * 拒绝由调用方吞掉：没有该命令的旧 APK 仍能得到页面内固定层，
 * 只是状态栏保持可见。
 */
export async function setAndroidImmersive(
  immersive: boolean,
  nativeInvoke: NativeImmersiveInvoke = invoke,
): Promise<void> {
  await nativeInvoke(NATIVE_SET_IMMERSIVE, { immersive });
}

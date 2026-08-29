import { invoke, isTauri } from "@tauri-apps/api/core";
import { getClientPlatform } from "@/shared/clientPlatform";

type NativeSystemBarsInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const SET_APPEARANCE_COMMAND = "android_system_bars_set_appearance";

/**
 * 保持平台判定为纯函数，便于测试桌面/浏览器兜底路径。
 */
export function supportsAndroidSystemBars({
  tauriRuntime,
  platform,
}: {
  tauriRuntime: boolean;
  platform: ReturnType<typeof getClientPlatform>;
}): boolean {
  return tauriRuntime && platform === "android";
}

function runningOnAndroidTauri(): boolean {
  return supportsAndroidSystemBars({
    tauriRuntime: isTauri(),
    platform: getClientPlatform(),
  });
}

/** 上次成功下发到原生的亮暗；null 表示尚未成功或上次失败。 */
let appliedDark: boolean | null = null;
/** 已排队或在途的最新目标值；null 表示当前没有待发送写入。 */
let scheduledDark: boolean | null = null;
let writeChain: Promise<void> = Promise.resolve();

/**
 * 把应用解析出的主题亮暗同步到 Android 系统栏图标颜色。
 *
 * - 非 Android / 非 Tauri 客户端直接返回（applyTheme 无条件调用）。
 * - 与上次成功值相同且没有排队写入则跳过；在途期间被新目标取代的值
 *   不再发送，链式写入保证原生看到的顺序与前端一致。
 * - 失败静默：系统栏 tint 不值得打断主题切换，且下次相同目标会重试。
 */
export function syncAndroidSystemBars(
  dark: boolean,
  options: {
    nativeInvoke?: NativeSystemBarsInvoke;
    supportsNative?: boolean;
  } = {},
): void {
  const supported = options.supportsNative ?? runningOnAndroidTauri();
  if (!supported) return;
  // 有排队/在途写入时不能按 appliedDark 去重：在途值可能晚于本次调用
  // 落地，跳过会让原生停在旧值上。
  if (scheduledDark === null && dark === appliedDark) return;
  if (dark === scheduledDark) return;
  const hasPendingWrite = scheduledDark !== null;
  scheduledDark = dark;
  if (hasPendingWrite) return;

  const nativeInvoke = options.nativeInvoke ?? invoke;
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      while (scheduledDark !== null && scheduledDark !== appliedDark) {
        const target = scheduledDark;
        try {
          await nativeInvoke(SET_APPEARANCE_COMMAND, { dark: target });
          appliedDark = target;
        } catch {
          // 失败后保持 appliedDark 语义（null）：下次相同目标会重试。
          appliedDark = null;
        }
        if (scheduledDark === target) {
          scheduledDark = null;
        }
      }
    });
}

/** 仅供测试重置模块级去重与队列状态。 */
export function resetAndroidSystemBarsForTests(): void {
  appliedDark = null;
  scheduledDark = null;
  writeChain = Promise.resolve();
}

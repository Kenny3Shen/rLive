/**
 * 离场期间跳过 Video.js Player store 的时间/缓冲写入。
 *
 * 不能用 `setMedia(null)` 来停掉逐帧循环：那会 detach 整个 store，把 paused、
 * buffering、PiP 等状态一起复位，离场播放器可能闪出暂停图标或缓冲转圈。
 * 这里保留媒体绑定，只在 feature 的 `set` 边界拦下状态发布；HTMLMediaElement
 * 本身、已解码画面与播放进度全部照常推进。
 */
import { REGISTERED_MEDIA } from "@videojs/media";
export { REGISTERED_MEDIA };
const quietMedia = new WeakSet<object>();

/** Player 可能把 media 包进 facade；标准符号能还原真实媒体元素。 */
function registeredMedia(media: unknown): object | null {
  if (!media || (typeof media !== "object" && typeof media !== "function")) return null;
  const value = Reflect.get(media, REGISTERED_MEDIA) ?? media;
  return typeof value === "object" && value !== null ? value : null;
}

export function setVideoPlayerTimeQuiet(media: HTMLMediaElement | null, quiet: boolean): void {
  const target = registeredMedia(media);
  if (!target) return;
  if (quiet) quietMedia.add(target);
  else quietMedia.delete(target);
}

/** 测试辅助：不改变媒体状态，只报告指定媒体是否仍处于离场静默。 */
export function isVideoPlayerTimeQuiet(media: HTMLMediaElement | null): boolean {
  const target = registeredMedia(media);
  return target !== null && quietMedia.has(target);
}

/**
 * 包装 feature 的 `set`：媒体被标记静默时，所有会通知 `useSyncExternalStore`
 * 的写入都在此拦下。事件监听器与 rAF 仍由 Video.js 自己管理。
 */
export function quietPlayerStoreSet<Patch>(
  media: unknown,
  set: (patch: Patch) => void,
): (patch: Patch) => void {
  const target = registeredMedia(media);
  if (!target) return set;
  return (patch) => {
    if (quietMedia.has(target)) return;
    set(patch);
  };
}

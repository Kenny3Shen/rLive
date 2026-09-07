import { useEffect, useState } from "react";
import { isMobileClient } from "@/shared/clientPlatform";

export const COMPACT_LANDSCAPE_PLAYER_QUERY =
  "(orientation: landscape) and (max-height: 540px) and (pointer: coarse)";
export const COMPACT_PLAYER_QUERY = `(max-width: 767px), ${COMPACT_LANDSCAPE_PLAYER_QUERY}`;
export const PORTRAIT_ORIENTATION_QUERY = "(orientation: portrait)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia(query).matches;
}

function isLandscapeViewport(): boolean {
  if (typeof window === "undefined") return false;

  const orientationType = window.screen.orientation?.type;
  if (orientationType) return orientationType.startsWith("landscape");

  const orientationAngle = window.screen.orientation?.angle;
  if (orientationAngle === 90 || orientationAngle === 270) return true;
  if (orientationAngle === 0 || orientationAngle === 180) return false;

  const legacyOrientation = (window as Window & { orientation?: number }).orientation;
  if (legacyOrientation === 90 || legacyOrientation === -90 || legacyOrientation === 270) {
    return true;
  }
  if (legacyOrientation === 0 || legacyOrientation === 180) return false;

  const viewport = window.visualViewport;
  return (viewport?.width ?? window.innerWidth) > (viewport?.height ?? window.innerHeight);
}

/**
 * 移动端 WebView 可能在首次渲染时上报布局前的媒体查询状态。
 * 在真正的 media query 监听器得到第一次稳定更新之前，
 * 先用移动端安全的答案播种播放器。
 */
export function playerViewportFallbackMatches(
  query: string,
  mobileClient: boolean,
  landscape: boolean,
): boolean {
  if (!mobileClient) return false;
  if (query === COMPACT_PLAYER_QUERY) return true;
  if (query === COMPACT_LANDSCAPE_PLAYER_QUERY) return landscape;
  if (query === PORTRAIT_ORIENTATION_QUERY) return !landscape;
  return false;
}

function initialMatches(query: string): boolean {
  if (matches(query)) return true;
  return playerViewportFallbackMatches(query, isMobileClient(), isLandscapeViewport());
}

/**
 * 解析播放器布局查询并保证它在冷启动期间正确。
 *
 * WebView 以调用那一刻拥有的视口评估 `matchMedia`，首次启动时该视口尚未稳定：
 * 初始 `useState` 读取和挂载时的重读都可能返回布局前的答案，
 * 而且浏览器不一定为这次初始修正发出 `change` 事件。一个把 `compact` 解析成
 * `false` 的播放器控制条会一直保持桌面密度 —— 多出的按钮加上中央槽位的内联输入
 * 框 —— 直到某个无关的 resize 终于触发。
 *
 * 因此挂载副作用也在下一帧重读，并把视口事件当作与 `change` 监听并列的重读触发。
 * 每次读取都汇入同一个 setter，React 会丢弃相同值的更新，
 * 取值稳定后这些额外检查零成本。
 */
function usePlayerMediaQuery(query: string): boolean {
  const [matched, setMatched] = useState(() => initialMatches(query));

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    // 读取只信 matchMedia。兜底只负责播种首个渲染帧：若在这里长期叠加
    // `mediaQuery.matches || fallback(...)`，任何移动客户端 —— 包括视口宽度
    // 超过 md 断点的平板 —— 都会被永久判成 compact，直播间因此永远走
    // 手机堆叠布局。真正的冷启动修正由下面的跨帧复读与视口事件承担。
    const update = () => setMatched(mediaQuery.matches);
    update();
    const updateFromEvent = () => update();

    // 跨越两次布局/绘制。Android 可能在第一帧之后才稳定全面屏 inset 与方向，
    // 而不发 media-query change。
    let secondFrame: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(update);
    });

    mediaQuery.addEventListener("change", updateFromEvent);
    window.addEventListener("resize", updateFromEvent);
    window.addEventListener("orientationchange", updateFromEvent);
    window.visualViewport?.addEventListener("resize", updateFromEvent);
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      mediaQuery.removeEventListener("change", updateFromEvent);
      window.removeEventListener("resize", updateFromEvent);
      window.removeEventListener("orientationchange", updateFromEvent);
      window.visualViewport?.removeEventListener("resize", updateFromEvent);
    };
  }, [query]);

  return matched;
}

/** 竖屏手机与较矮的触摸横屏使用相同的控件密度。 */
export function useCompactPlayerViewport(): boolean {
  return usePlayerMediaQuery(COMPACT_PLAYER_QUERY);
}

export function useCompactLandscapePlayerViewport(): boolean {
  return usePlayerMediaQuery(COMPACT_LANDSCAPE_PLAYER_QUERY);
}

/**
 * 竖屏方向，经共享查询路径解析，使首屏与后续 change 事件一致，
 * 而不是各调用方各自 ad-hoc 地 matchMedia。
 */
export function usePortraitOrientation(): boolean {
  return usePlayerMediaQuery(PORTRAIT_ORIENTATION_QUERY);
}

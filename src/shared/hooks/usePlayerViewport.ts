import { useEffect, useState } from "react";
import { isMobileClient } from "@/shared/clientPlatform";

const COMPACT_LANDSCAPE_PLAYER_QUERY =
  "(orientation: landscape) and (max-height: 540px) and (pointer: coarse)";
const COMPACT_PLAYER_QUERY = `(max-width: 767px), ${COMPACT_LANDSCAPE_PLAYER_QUERY}`;
const PORTRAIT_ORIENTATION_QUERY = "(orientation: portrait)";
/**
 * 详情侧栏列在舞台**下方**的宽度档（与播放页的 `lg:flex-row` 断点互斥）。
 *
 * 窄屏把侧栏接在舞台下方，占比拖动才有意义；宽屏两侧栏并排，上下拖不改任何布局。
 * 取值与样式表里那条 `@media (width < 64rem)` 是同一档，两处必须一起改 ——
 * 否则会出现「手势被启用但拖不动」或「能拖动但手势没开」的错位。
 */
const STACKED_DETAILS_QUERY = "(width < 64rem)";

type PlayerViewportSnapshot = {
  mobileClient: boolean;
  /** `null` 表示所有方向来源都无法区分横竖屏。 */
  landscape: boolean | null;
  width: number | null;
  height: number | null;
  coarsePointer: boolean;
  mediaMatches: boolean;
};

export function playerViewportIsLandscape({
  orientationType,
  orientationAngle,
  legacyOrientation,
  width,
  height,
}: {
  orientationType?: string;
  orientationAngle?: number;
  legacyOrientation?: number;
  width?: number | null;
  height?: number | null;
}): boolean | null {
  if (orientationType) return orientationType.startsWith("landscape");

  if (orientationAngle === 90 || orientationAngle === 270) return true;
  if (orientationAngle === 0 || orientationAngle === 180) return false;

  if (legacyOrientation === 90 || legacyOrientation === -90 || legacyOrientation === 270) {
    return true;
  }
  if (legacyOrientation === 0 || legacyOrientation === 180) return false;

  if (width === null || width === undefined || height === null || height === undefined) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (width === height) return null;
  return width > height;
}

/**
 * 解析一次视口采样。
 *
 * 移动端 WebView 首次渲染时，`matchMedia` 可能仍停留在布局前，方向尤其容易
 * 与真实屏幕相反。因此移动端的方向查询先读 `screen.orientation`；它不可用时
 * 才退回真实视口宽高。宽高断点同样优先使用数值，避免媒体查询在冷启动时把
 * 平板误判成手机，或让移动端永久保持紧凑布局。桌面端继续完全尊重媒体查询。
 */
export function resolvePlayerViewportMatch(
  query: string,
  snapshot: PlayerViewportSnapshot,
): boolean {
  if (!snapshot.mobileClient) return snapshot.mediaMatches;

  if (query === PORTRAIT_ORIENTATION_QUERY) {
    return snapshot.landscape === null ? snapshot.mediaMatches : !snapshot.landscape;
  }

  if (query === COMPACT_LANDSCAPE_PLAYER_QUERY) {
    if (snapshot.landscape === null || snapshot.height === null) return snapshot.mediaMatches;
    return snapshot.landscape && snapshot.height <= 540 && snapshot.coarsePointer;
  }

  if (query === COMPACT_PLAYER_QUERY) {
    if (snapshot.width === null) return snapshot.mediaMatches;
    const narrow = snapshot.width <= 767;
    const shortLandscape =
      snapshot.landscape === true &&
      snapshot.height !== null &&
      snapshot.height <= 540 &&
      snapshot.coarsePointer;
    return narrow || shortLandscape;
  }

  if (query === STACKED_DETAILS_QUERY) {
    return snapshot.width === null ? snapshot.mediaMatches : snapshot.width < 1024;
  }

  return snapshot.mediaMatches;
}

function readPlayerViewportSnapshot(query: string): PlayerViewportSnapshot {
  if (typeof window === "undefined") {
    return {
      mobileClient: false,
      landscape: null,
      width: null,
      height: null,
      coarsePointer: false,
      mediaMatches: false,
    };
  }

  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const screenOrientation = window.screen.orientation;
  const media = window.matchMedia(query);
  const mobileClient = isMobileClient();
  return {
    mobileClient,
    landscape: playerViewportIsLandscape({
      orientationType: screenOrientation?.type,
      orientationAngle: screenOrientation?.angle,
      legacyOrientation: (window as Window & { orientation?: number }).orientation,
      width,
      height,
    }),
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
    coarsePointer: mobileClient || window.matchMedia("(pointer: coarse)").matches,
    mediaMatches: media.matches,
  };
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
  const [matched, setMatched] = useState(() =>
    resolvePlayerViewportMatch(query, readPlayerViewportSnapshot(query)),
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const update = () =>
      setMatched(resolvePlayerViewportMatch(query, readPlayerViewportSnapshot(query)));
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
    window.screen.orientation?.addEventListener("change", updateFromEvent);
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      mediaQuery.removeEventListener("change", updateFromEvent);
      window.removeEventListener("resize", updateFromEvent);
      window.removeEventListener("orientationchange", updateFromEvent);
      window.visualViewport?.removeEventListener("resize", updateFromEvent);
      window.screen.orientation?.removeEventListener("change", updateFromEvent);
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

/** 详情侧栏是否列在舞台下方（窄屏），见 `STACKED_DETAILS_QUERY`。 */
export function useStackedDetailsViewport(): boolean {
  return usePlayerMediaQuery(STACKED_DETAILS_QUERY);
}

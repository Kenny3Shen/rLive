import { useLayoutEffect, useRef, type RefObject } from "react";
import { motionProfile, prefersReducedMotion } from "./tokens";
import { tween } from "./tween";
import {
  lockVideoStartupOrientation,
  shouldRevealVideoStartup,
  VIDEO_STARTUP_CHROME_SELECTOR,
  VIDEO_STARTUP_DETAILS_SELECTOR,
  videoStartupKeyframes,
  type VideoStartupOrientation,
} from "./videoStartupReveal";

type ActiveReveal = {
  animations: Animation[];
  settled: boolean;
};

/**
 * 媒体可播后才挂载的 VOD 外围界面共享一次入场。
 *
 * 目标只选控制层和详情表面，媒体节点及其祖先始终留在动画之外。方向在当前
 * 路由 entry 第一次出现时锁定。只有路由进入或同路由的新历史条目会触发动画；
 * 换画质、自动恢复、重试以及 gate 关闭后重开同一 entry 都不会重播。
 */
export function useVideoStartupReveal({
  containerRef,
  entryKey,
  ready,
  orientation,
  mobileClient,
}: {
  containerRef: RefObject<HTMLElement | null>;
  entryKey: string;
  ready: boolean;
  orientation: VideoStartupOrientation;
  mobileClient: boolean;
}) {
  const lockedOrientationRef = useRef<{
    entryKey: string;
    orientation: VideoStartupOrientation;
  } | null>(null);
  const orientationRef = useRef(orientation);
  const attemptedEntryRef = useRef<string | null>(null);
  const activeRef = useRef<ActiveReveal | null>(null);

  // 路由 entry 第一次出现时就锁定方向，不等到媒体起播：用户在等待期间旋转，
  // 仍使用进入这个历史条目时看到的方向。方向变化不会重启入场动画。
  useLayoutEffect(() => {
    orientationRef.current = orientation;
    lockedOrientationRef.current = lockVideoStartupOrientation(
      lockedOrientationRef.current,
      entryKey,
      orientation,
    );
  }, [entryKey, orientation]);

  useLayoutEffect(() => {
    const reducedMotion = prefersReducedMotion();
    if (
      !shouldRevealVideoStartup({
        ready,
        mobileClient,
        reducedMotion,
        entryKey,
        attemptedEntryKey: attemptedEntryRef.current,
      })
    ) {
      if (ready && reducedMotion) attemptedEntryRef.current = entryKey;
      return;
    }

    const container = containerRef.current;
    if (!container) return;
    const lockedOrientation =
      lockedOrientationRef.current?.entryKey === entryKey
        ? lockedOrientationRef.current.orientation
        : orientationRef.current;
    const keyframes = videoStartupKeyframes(lockedOrientation);
    const chromeElements = Array.from(
      container.querySelectorAll<HTMLElement>(VIDEO_STARTUP_CHROME_SELECTOR),
    );
    const detailsElements = Array.from(
      container.querySelectorAll<HTMLElement>(VIDEO_STARTUP_DETAILS_SELECTOR),
    );
    const elements = [...chromeElements, ...detailsElements];
    // 父级可能在媒体放行的同一帧才挂载外围界面；没有目标时留待后续提交再揭示。
    if (elements.length === 0) return;

    const profile = motionProfile();
    const animations = [
      ...chromeElements.map((element) =>
        tween(element, keyframes.chrome, {
          duration: profile.enter.duration * 1000,
          easing: profile.enter.ease,
        }),
      ),
      ...detailsElements.map((element) =>
        tween(element, keyframes.details, {
          duration: profile.enter.duration * 1000,
          easing: profile.enter.ease,
        }),
      ),
    ];
    const active: ActiveReveal = {
      animations,
      settled: false,
    };
    activeRef.current = active;

    // StrictMode 会在首帧前重放 layout effect。等第一帧真正提交后再登记
    // “本 entry 已尝试”，既保留开发态的入场，也让 gate 后续关闭重开不再重播。
    const attemptedFrame = window.requestAnimationFrame(() => {
      if (activeRef.current === active) attemptedEntryRef.current = entryKey;
    });

    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (activeRef.current !== active || active.settled) return;
      active.settled = true;
      for (const animation of animations) animation.cancel();
    });

    return () => {
      if (activeRef.current !== active) return;
      activeRef.current = null;
      window.cancelAnimationFrame(attemptedFrame);
      for (const animation of animations) animation.cancel();
      // 不在 cleanup 清掉 entry 标记：gate 关闭重开必须沿用首次进入的尝试记录。
    };
  }, [containerRef, entryKey, mobileClient, ready]);
}

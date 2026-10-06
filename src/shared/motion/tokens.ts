import { isMobileClient } from "@/shared/clientPlatform";
export { prefersReducedMotion } from "./preference";

/**
 * 系统感动效词汇表：直接操作快速响应，大面积移动留出减速距离。
 * 仅使用 WAAPI / CSS 的 transform 与 opacity，不引入逐帧 JS 弹簧或布局补间。
 * CSS 对应值位于 styles.css 的 --motion-*，由回归测试防止两端漂移。
 */
export const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";
/** 页面和抽屉共用的强调减速：快速到达可读位置，尾段平稳落位，不越冲。 */
export const EASE_EMPHASIZED = "cubic-bezier(0.32, 0.72, 0, 1)";
/** 离场加速清场，不沿用入场的长减速尾巴。 */
export const EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";
/**
 * 跟手释放保留非零起始速度，不能用从静止起步的 EASE_OUT。
 * 时长仍由 horizontalSwipeSettleDuration 根据剩余距离与松手速度推导。
 */
export const SWIPE_SETTLE_EASING = "cubic-bezier(0.215, 0.61, 0.355, 1)";

/** 水平页内容盒小于裁剪视口时，多走 10% 避免边缘留下离场页。 */
export const PAGE_PAN_PERCENT = 110;

export type MotionProfile = {
  enter: { duration: number; ease: string };
  exit: { duration: number; ease: string };
  /** 房间往返沿同一纵深运动；两层以同一总时长完成交接。 */
  roomZoom: { duration: number; ease: string };
};

const DESKTOP_PROFILE: MotionProfile = {
  enter: { duration: 0.28, ease: EASE_EMPHASIZED },
  exit: { duration: 0.28, ease: EASE_EMPHASIZED },
  roomZoom: { duration: 0.3, ease: EASE_EMPHASIZED },
};

const TOUCH_PROFILE: MotionProfile = {
  // 大幅触摸导航不靠缩短时长制造「快」：前段立即响应，尾段有足够帧数减速。
  // PagePan 的两页是连续表面，必须共享时长与曲线，不能套用弹层的快退出。
  enter: { duration: 0.32, ease: EASE_EMPHASIZED },
  exit: { duration: 0.32, ease: EASE_EMPHASIZED },
  roomZoom: { duration: 0.34, ease: EASE_EMPHASIZED },
};

export function motionProfile(): MotionProfile {
  return isMobileClient() ? TOUCH_PROFILE : DESKTOP_PROFILE;
}

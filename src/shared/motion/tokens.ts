import { isMobileClient } from "@/shared/clientPlatform";
export { prefersReducedMotion } from "./preference";

/**
 * 共享动效词汇表。应用动画统一由 Web Animations API 与 CSS 原生承担，
 * 不引入 JS 动画库。
 *
 * 两条规则使它在繁忙的直播播放器帧上也负担得起：
 *
 * 1. 只对 transform 和 opacity 做动画，所有序列都留在合成器上。不用
 * width/height/color/filter 补间。
 * 2. 时长保持很短。触摸客户端获得更快的收尾，让下一个视图在拇指下更早可读。
 *
 * 页面过渡使用短时长的缓动；指针驱动的滑动在手指按下时直接写 transform、
 * 只在释放时补间，因此一个手势绝不会每帧分配一个补间。
 */

/**
 * 入场减速曲线 —— `power2.out`（quad out）的 cubic-bezier 等价物。
 *
 * Web Animations 与 CSS transition 共用同一条曲线：transform / opacity
 * 动画在 React 忙于提交时仍由 Chromium 合成器推进，这是 rAF ticker 驱动
 * 的 JS 补间库做不到的。页面平移、缩放过渡与指针驱动的页面收尾都读它，
 * 因此共享一条曲线而不是各挑一条 bezier。
 */
export const EASE_OUT = "cubic-bezier(0.215, 0.61, 0.355, 1)";
/**
 * 指针驱动页面滑动的释放阶段缓动。
 *
 * 收尾延续手指已经开始的运动，因此曲线要在释放点快速离开、减速进入静止。
 * 它的时长不是常量：`horizontalSwipeSettleDuration` 由剩余距离和松手速度推导，
 * 快甩迅速完成，慢拖在更长坡道上缓缓停下。
 */
export const SWIPE_SETTLE_EASING = EASE_OUT;

/**
 * 施加到每次整页平移的额外行程，以其活动轴的比例计。
 *
 * 刻意略超 100%。动画元素是滚动容器内带内边距的内容盒，
 * 其自身尺寸可能因 padding 小于被裁剪的视口。正好平移 100% 可能在边缘留下一线
 * 离场页直到卸载。额外的 10% 在任何现实视口下都能清掉这条沟槽。
 */
export const PAGE_PAN_PERCENT = 110;

export type MotionProfile = {
  /** 页面平移行程占页面活动轴尺寸的百分比。 */
  tabTravel: number;
  enter: { duration: number; ease: string };
  exit: { duration: number; ease: string };
  /**
   * 沉浸播放器缩放，`PageZoom` 两个方向共用。
   *
   * 用一个时长而不是进/出配对：进入房间与离开它是同一段交叉淡化的正反播放，
   * 给它们不同长度会让往返显得失衡。比页面平移略长，
   * 因为是两块全视口表面相互溶解，且房间背后还要带起一个播放器。
   */
  roomZoom: { duration: number; ease: string };
};

const DESKTOP_PROFILE: MotionProfile = {
  // 整面平移：两页作为一个连续视口一起移动。
  tabTravel: PAGE_PAN_PERCENT,
  enter: { duration: 0.22, ease: EASE_OUT },
  exit: { duration: 0.22, ease: EASE_OUT },
  roomZoom: { duration: 0.26, ease: EASE_OUT },
};

const TOUCH_PROFILE: MotionProfile = {
  // 触摸导航读作手指的延伸：整页跟随穿过视口，
  // 收尾比桌面稍快一点。
  tabTravel: PAGE_PAN_PERCENT,
  enter: { duration: 0.2, ease: EASE_OUT },
  exit: { duration: 0.2, ease: EASE_OUT },
  roomZoom: { duration: 0.22, ease: EASE_OUT },
};

export function motionProfile(mobile: boolean = isMobileClient()): MotionProfile {
  return mobile ? TOUCH_PROFILE : DESKTOP_PROFILE;
}

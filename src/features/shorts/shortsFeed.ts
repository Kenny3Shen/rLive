/**
 * 短视频（竖屏流）的纯逻辑：路由契约、画幅判定、纵向翻页几何与会话保留策略。
 *
 * 抽成不 import React 的模块，是为了让「滑到哪一条」「保留哪几个播放会话」这些
 * 决策可以单测 —— 它们是竖屏消费体验的正确性核心，而竖屏舞台本身几乎全是副作用。
 *
 * 纵向翻页刻意不复用 `useHorizontalSwipe`：那个 hook 的 `transformFor` 硬编码
 * `translate3d(x, 0, 0)`，且它的语义是「有序页签之间换页」（提交后由路由带入新页）。
 * 短视频是同一条无限流内部的定位，条目数会在滑动过程中增长，两者的提交语义不同。
 * 共用的是阈值口径与释放收尾的算法（见下方常量注释）。
 */

import type { VideoDimension, VideoItem } from "@/shared/types/video";

/** 短视频页路径。刻意不挂在 `/video` 下：侧栏「视频」项按前缀匹配会跟着高亮。 */
export const SHORTS_PATH = "/shorts";

/** 媒体自己报出的原始画幅（`videoWidth` / `videoHeight`），起播后才有。 */
export type ShortsIntrinsicSize = { width: number; height: number };

/**
 * 这一条的显示宽高比（宽 / 高）；无从得知时返回 null。
 *
 * 优先用媒体自报的 `videoWidth/videoHeight`：那是真正要显示的画幅，而列表下发的
 * `dimension` 只是起播前的先验（也可能与实际取到的流不一致）。
 *
 * `rotate` 非 0 时宽高互换 —— B 站这个字段是 0/1 标志而不是角度（见
 * `docs/zh/短视频调研-B站与抖音.md`），因此判定「非 0 即互换」而不是只认 90/270。
 *
 * 两个来源都没有时返回 null 而不是猜 9:16：猜错的代价是画面被按错误比例定框，
 * 而 null 会让舞台退回「画面框 = 舞台」，由 `object-contain` 自己居中留边。
 */
export function shortsMediaAspect(
  dimension: VideoDimension | null | undefined,
  intrinsic?: ShortsIntrinsicSize | null,
): number | null {
  if (intrinsic && intrinsic.width > 0 && intrinsic.height > 0) {
    return intrinsic.width / intrinsic.height;
  }
  if (!dimension) return null;
  const { width, height, rotate } = dimension;
  if (!(width > 0) || !(height > 0)) return null;
  return rotate === 0 ? width / height : height / width;
}

/**
 * 底部控制行的高度（px）：弹幕输入 + 右侧几个按钮那一行，不含进度条与安全区。
 */
export const SHORTS_BOTTOM_CONTROLS_HEIGHT_PX = 56;

/**
 * 进度条视觉粗细（px）。
 *
 * 它同时是底栏的上边缘：进度条贴在控制行顶边，替掉原来那条 `border-t`。命中区比这
 * 粗得多（向**上**撑开到画面上，见 `ShortsSeekBar`），但只有这 3px 占布局空间 ——
 * 命中区若也占空间，就会在画面与进度条之间凭空多出一条它自己的边距。
 */
export const SHORTS_SEEK_BAR_HEIGHT_PX = 3;

/**
 * 进度条命中区的高度（px）。
 *
 * 3px 的视觉粗细在触摸屏上按不到，命中区因此撑到 20px（约等于一个指尖）。它是绝对
 * 定位的浮层，只向**上**长 —— 向下就压到控制行的按钮上了。
 */
export const SHORTS_SEEK_BAR_HIT_HEIGHT_PX = 20;

/**
 * 进度条命中区探进画面的高度（px）。
 *
 * 命中区只占 3px 布局空间、却向上盖住 17px，因此贴着底栏摆的浮层（信息与评论）必须
 * 自己让开这一段，否则点在评论数字上会变成一次 seek —— 实测重叠 9px（浮层原来只留
 * 了 8px 内边距），点评论数字会把播放位置拖到 0。
 *
 * 由两段相减而不是写字面量：命中区或视觉粗细任一个变了，让位距离必须跟着变，写死
 * 会在下一次调整时静默地重新压上去。
 */
export const SHORTS_SEEK_BAR_HIT_OVERHANG_PX =
  SHORTS_SEEK_BAR_HIT_HEIGHT_PX - SHORTS_SEEK_BAR_HEIGHT_PX;

/**
 * 底部操作栏占掉的总高度（px），不含底部安全区。
 *
 * 页面级的操作栏与每个面板内的画面区必须用同一个数：画面区按
 * `bottom: calc(此值 + 底部安全区)` 收边，操作栏按同样的高度铺在下面，两者对不上
 * 就会出现画面被压住或者中间裂一条缝。因此这个常量是两个组件之间的契约，放在这里
 * 而不是各写一份字面量。
 *
 * 由两段相加而不是写字面量：进度条移进底栏之后，「底栏多高」不再是一个独立的设计
 * 数字，而是「控制行 + 进度条」的和。改任一段都不该再去手算这个总数。
 */
export const SHORTS_BOTTOM_BAR_HEIGHT_PX =
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX + SHORTS_SEEK_BAR_HEIGHT_PX;

/**
 * 安全区的 CSS 表达式。
 *
 * 原生注入的 `--android-safe-area-*` 优先于 `env(safe-area-inset-*)`：Android
 * WebView 的 `env()` 会读成 0（`MainActivity` 因此用 `getInsetsIgnoringVisibility`
 * 把真值写成 CSS 变量，见 `styles.css` 里同一套写法）。直接用 `env()` 的后果是
 * 底部操作栏压在系统手势指示条下面 —— 手势条会吃掉那一段的触摸。
 *
 * 保留 `env()` 作为回退：旧 APK 没有那个变量，浏览器里也没有。
 */
export const SHORTS_SAFE_AREA_TOP = "var(--android-safe-area-top, env(safe-area-inset-top))";
export const SHORTS_SAFE_AREA_BOTTOM =
  "var(--android-safe-area-bottom, env(safe-area-inset-bottom))";

/**
 * 顶部控制栏的高度（px），不含顶部安全区。
 *
 * 同时也是弹幕的起始纵坐标：画面框顶对齐到安全区下沿，控制栏正好占住画面框顶部
 * 这么高一条，弹幕从它下面开始滚才不会被返回/更多按钮压住（见
 * `--video-danmaku-top`）。
 */
export const SHORTS_TOP_BAR_HEIGHT_PX = 52;

/**
 * 弹幕起始纵坐标（px），相对画面框顶边。
 *
 * 等于顶部控制栏的高度：画面框顶对齐到安全区下沿，控制栏正好压在画面框顶部这么
 * 高一条上。别名而不是直接用上面那个常量，是因为两者的含义在概念上可以分开 ——
 * 「控制栏多高」与「弹幕从哪开始」只是此刻恰好相等，后者若要再留一点余量，改这里
 * 就够，不必去动布局契约。
 */
export const SHORTS_DANMAKU_TOP_OFFSET_PX = SHORTS_TOP_BAR_HEIGHT_PX;

/**
 * 键盘左右方向键的单次跳转步长（秒）。
 *
 * 与播放页的快捷键同一口径：短视频普遍只有几十秒，5 秒是「跳过一小段」而不是
 * 「跳到别处」。上下方向键仍归换片，两者不在同一根轴上。
 */
export const SHORTS_SEEK_KEY_STEP_SECONDS = 5;

/**
 * 拖动进度时预览缩略图的宽度（px）。
 *
 * 取 160 是因为 B 站快照雪碧图的单格就是 160×90：按原始尺寸显示不用缩放，也就不会
 * 出现雪碧图偏移被小数倍率放大成半像素错位（相邻格漏进来一条边）。它同时是气泡
 * 夹边的宽度基准，见 `shortsSeekPreviewLeft`。
 */
export const SHORTS_SEEK_PREVIEW_WIDTH_PX = 160;

/**
 * 画面在舞台里的实际显示尺寸：按宽高比等比内切，不裁切也不拉伸。
 *
 * 这是「短视频不该被强行铺满」的几何本体。竖屏源在桌面宽舞台上若按 `cover` 铺满，
 * 会先填满宽度再让高度溢出（1920 宽的舞台上 9:16 的画面高约 3400px），结果只看得见
 * 画面中间一条 —— 桌面端短视频的做法是把画面按原比例居中成一张卡片，周围交给背景。
 *
 * 内切对竖屏和横屏一视同仁：竖屏在手机上（视口本就接近 9:16）几乎正好铺满，
 * 在桌面上收成居中的竖卡；横屏则是常规的上下留边。
 *
 * 宽高比未知时退回舞台自身尺寸，让 `object-contain` 接手。
 */
export function shortsMediaFrame(
  stageWidth: number,
  stageHeight: number,
  aspect: number | null,
): { width: number; height: number } {
  const width = Math.max(0, stageWidth);
  const height = Math.max(0, stageHeight);
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  if (!aspect || !(aspect > 0) || !Number.isFinite(aspect)) return { width, height };
  // 画面比舞台更「宽」则宽度先到边，否则高度先到边。
  return aspect > width / height
    ? { width, height: width / aspect }
    : { width: height * aspect, height };
}

/**
 * 画面框在画面区里的纵向对齐方式。
 *
 * 竖屏源顶对齐：手机视口比 9:16 更长（9:19.5），居中会在画面**上方**留一条黑边，
 * 而那一段正是状态栏之下最该被画面占满的位置 —— 让出来的空隙归下方，那里本来就要
 * 放操作栏。
 *
 * 横屏源居中：16:9 的画面在竖屏视口里只占中间一小条，顶对齐会把它按在顶部控制栏
 * 底下，下方剩一大片背景 —— 观感是「画面掉上去了」。上下对称留边才是横屏在竖屏
 * 设备上的常规画法（与播放页一致）。
 *
 * 判据取宽高比而不是「留边有多少」：后者随视口变化，同一条视频在手机与桌面上会得到
 * 不同的对齐方式，换设备就换构图。方形（aspect === 1）归到横屏一侧居中 —— 它没有
 * 「竖屏要顶格」的诉求。
 */
export function shortsFrameAlign(aspect: number | null): "start" | "center" {
  if (!aspect || !(aspect > 0) || !Number.isFinite(aspect)) return "center";
  return aspect < 1 ? "start" : "center";
}

/**
 * 允许为「铺满」裁掉的最大比例。
 *
 * 两个宽高比的相对差值超过这个数就不再裁切，改回等比留边。取 0.1 是照真实机型的
 * 需求量定的（画面区 = 视口高 − 顶部安全区 − 底栏 59px − 底部安全区，9:16 源）：
 *
 * | 机型 | 屏幕比 | 要裁 | 结果 |
 * | --- | --- | --- | --- |
 * | iPhone 13 / 15 Pro Max | 19.5:9 | 宽 1.5% / 2.0% | 铺满 |
 * | Galaxy S22 | 19.5:9 | 宽 4.9% | 铺满 |
 * | Pixel 5 | 19.5:9 | 宽 6.1% | 铺满 |
 * | Pixel 8 | 20:9 | 宽 9.4% | 铺满 |
 * | iPhone SE | 16:9 | **高** 11.8% | 留边 |
 * | 21:9 概念机 | 21:9 | 宽 13.7% | 留边 |
 *
 * 卡在 10% 而不是 12%，是为了把 iPhone SE 那一档挡在外面：它的画面区比 9:16 更
 * 「宽」，铺满要裁的是**高**（竖屏视频的上下两端 —— 脸、字幕、贴片都在那儿），
 * 代价比裁两侧大得多。10% 收下全部 19.5:9 与 20:9 主流机型，放过 16:9 与 21:9
 * 这两个极端。
 */
export const SHORTS_FRAME_FILL_MAX_CROP = 0.1;

/**
 * 为了铺满画面区，需要裁掉源画面的比例（0~1）。
 *
 * 两个宽高比的相对差值，与哪个更大无关：画面区比源更「高」时裁的是宽，更「宽」时
 * 裁的是高，但要裁掉的**比例**在两种情况下是同一个式子。调用方因此不必分轴讨论。
 */
export function shortsFrameCrop(areaAspect: number, sourceAspect: number): number {
  if (!(areaAspect > 0) || !(sourceAspect > 0)) return 0;
  return 1 - Math.min(areaAspect, sourceAspect) / Math.max(areaAspect, sourceAspect);
}

/**
 * 这一条该不该裁切铺满画面区（而不是等比留边）。
 *
 * 竖屏源在手机上永远差一点点铺满：9:16 放进 9:19.5 的屏幕，等比内切之后画面与
 * 底部操作栏之间会留一条几十像素的空隙。差得这么少的时候，裁掉两侧不到一成远比
 * 留一条空隙好看 —— 这就是这个函数存在的理由。
 *
 * 只对**竖屏源**开这个口子：横屏源在竖屏视口里差得极远（16:9 放进 9:19.5 要裁掉
 * 七成），必须留边居中（见 `shortsFrameAlign`）。把判据写成「竖屏 + 差值够小」而不是
 * 只看差值，也让横屏在桌面上的画法保持不变 —— 那里画面区已经接近 16:9，一旦按差值
 * 判定就会转成裁切，而那不是这次要改的东西。
 */
export function shortsFrameFill(
  areaWidth: number,
  areaHeight: number,
  aspect: number | null,
): boolean {
  if (!aspect || !(aspect > 0) || !Number.isFinite(aspect)) return false;
  // 横屏与方形源一律留边。
  if (aspect >= 1) return false;
  if (!(areaWidth > 0) || !(areaHeight > 0)) return false;
  return shortsFrameCrop(areaWidth / areaHeight, aspect) <= SHORTS_FRAME_FILL_MAX_CROP;
}

/**
 * 拖动进度时预览气泡的左偏移（px，相对轨道左端）。
 *
 * 气泡跟着手指但不许探出轨道两端：缩略图有 160px 宽，在手机上贴边时会有一半飘到
 * 画面之外。夹在 `[0, track - preview]` 里，轨道比气泡还窄时退回 0（此时无处可夹）。
 */
export function shortsSeekPreviewLeft(
  ratio: number,
  trackWidth: number,
  previewWidth: number,
): number {
  if (!(trackWidth > 0) || !(previewWidth > 0)) return 0;
  const centered = Math.max(0, Math.min(1, ratio)) * trackWidth - previewWidth / 2;
  const max = trackWidth - previewWidth;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(max, centered));
}

/**
 * 跨页去重后的短视频条目。
 *
 * story feed 无游标：翻页就是「再拉一批轮换内容」，后端已按批去重，但跨页重复
 * 仍会发生（轮换由服务端时间轴推进，不保证不回头）。这里同时丢掉缺取流键的条目 ——
 * 竖屏舞台没有「先取详情补 cid」的中间态，拿不到 cid 的条目直接不该进流。
 */
export function shortsFeedItems(pages: readonly { items: readonly VideoItem[] }[]): VideoItem[] {
  const seen = new Set<string>();
  const items: VideoItem[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (!item.bvid || !item.cid || item.cid <= 0) continue;
      if (seen.has(item.bvid)) continue;
      seen.add(item.bvid);
      items.push(item);
    }
  }
  return items;
}

/**
 * 进度条上某个横坐标对应的播放比例（0~1）。
 *
 * 只按进度条自身的矩形换算，与舞台无关：需求是「仅在进度条区域操作有效」，
 * 因此这个函数拿到的 `left`/`width` 必须是那条轨道的矩形，不是画面框的。
 */
export function shortsSeekRatio(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(1, (clientX - left) / width));
}

/** 比例对应的秒数。时长未知时返回 0（调用方据此不发起 seek）。 */
export function shortsSeekTime(ratio: number, duration: number): number {
  if (!(duration > 0)) return 0;
  const bounded = Math.max(0, Math.min(1, ratio));
  return bounded * duration;
}

/** 一条短视频在播放/预取层里的身份。与播放列表项的 id 同构（`bvid_cid`）。 */
export function shortsItemKey(item: Pick<VideoItem, "bvid" | "cid">): string {
  return `${item.bvid}_${item.cid ?? 0}`;
}

/** 轴向锁定前必须走过的距离（px）。与画面表面其他手势同一口径，见 `videoSurfaceGesture`。 */
export const SHORTS_SWIPE_LOCK_DISTANCE_PX = 12;
/** 主轴必须超过副轴的倍数，斜向拖动一律不认领。 */
const SHORTS_SWIPE_DIRECTION_RATIO = 1.25;
/**
 * 慢速拖拽提交换片所需的舞台高度比例。
 *
 * 比横向翻页（0.1）高一档：横滑翻页在页签之间来回是廉价的，而换片会拆掉当前
 * 播放会话、重新取流。误触的代价不对称，因此要求更明确的位移。
 */
export const SHORTS_SWIPE_COMMIT_PROGRESS = 0.18;
/** 释放速度阈值（px/ms），超过则无论进度如何都换片。与横向翻页同值。 */
export const SHORTS_SWIPE_FLING_VELOCITY_PX_PER_MS = 0.32;
/** 首尾条目上的越界阻尼：让边界可见，又不暗示这条流可以环绕。 */
const SHORTS_SWIPE_EDGE_RESISTANCE = 0.18;
/** 释放收尾时长的边界（ms）。 */
export const SHORTS_SWIPE_SETTLE_MIN_MS = 170;
export const SHORTS_SWIPE_SETTLE_MAX_MS = 400;
const SHORTS_SWIPE_SETTLE_MIN_SPEED = 0.7;
const SHORTS_SWIPE_SETTLE_MAX_SPEED = 3;
/** 释放速度的采样窗口（ms），约两个合成帧。 */
export const SHORTS_SWIPE_VELOCITY_WINDOW_MS = 32;

export type ShortsSwipeSample = {
  /** 手势轴（纵向）上的指针位置（px）。 */
  y: number;
  /** 采样时刻的 `performance.now()`。 */
  time: number;
};

/**
 * 这次按压是否交给纵向换片。
 *
 * 竖屏舞台上没有别的纵向手势（刻意不启用左右半屏亮度/音量：那套要求画面静止时
 * 的精细拖动，与「上下滑动换片」在同一根轴上不可共存），因此纵向一律接手，
 * 横向与斜向拒绝。
 */
export function shortsSwipeIntent(deltaX: number, deltaY: number): "pending" | "switch" | "reject" {
  const horizontal = Math.abs(deltaX);
  const vertical = Math.abs(deltaY);
  if (horizontal < SHORTS_SWIPE_LOCK_DISTANCE_PX && vertical < SHORTS_SWIPE_LOCK_DISTANCE_PX) {
    return "pending";
  }
  if (
    vertical >= SHORTS_SWIPE_LOCK_DISTANCE_PX &&
    vertical > horizontal * SHORTS_SWIPE_DIRECTION_RATIO
  ) {
    return "switch";
  }
  return "reject";
}

/** 由样本尾部计算的纵向释放速度（px/ms）。抬手前停顿过的手指上报约 0。 */
export function shortsSwipeVelocity(
  samples: readonly ShortsSwipeSample[],
  windowMs: number = SHORTS_SWIPE_VELOCITY_WINDOW_MS,
): number {
  const latest = samples[samples.length - 1];
  if (!latest) return 0;
  let oldest = latest;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (latest.time - sample.time > windowMs) break;
    oldest = sample;
  }
  const elapsed = latest.time - oldest.time;
  if (elapsed <= 0) return 0;
  return (latest.y - oldest.y) / elapsed;
}

/**
 * 条带跟手时使用的纵向偏移。
 *
 * 有效方向上最多跟手一整个舞台高度；在第一条（上滑）与最后一条（下滑）处
 * 大幅阻尼。`length` 是**已加载**的条目数：流还在增长，最后一条上的阻尼因此是
 * 「暂时到底」的反馈，而不是终点声明。
 */
export function shortsSwipeDragOffset(
  index: number,
  length: number,
  deltaY: number,
  stageHeight: number,
): number {
  if (length <= 0 || index < 0 || index >= length) return 0;
  const maxTravel = Math.max(0, stageHeight);
  const bounded = Math.max(-maxTravel, Math.min(maxTravel, deltaY));
  const nextIndex = index + (deltaY < 0 ? 1 : -1);
  const atBoundary = nextIndex < 0 || nextIndex >= length;
  return atBoundary ? bounded * SHORTS_SWIPE_EDGE_RESISTANCE : bounded;
}

/** 实时拖拽覆盖的带符号舞台比例。 */
export function shortsSwipeProgress(dragOffset: number, stageHeight: number): number {
  if (!(stageHeight > 0)) return 0;
  return Math.max(-1, Math.min(1, dragOffset / stageHeight));
}

/**
 * 指针释放后该停在哪一条；null 表示留在原处。
 *
 * 负偏移（手指上移）前进到下一条，正偏移回到上一条。与横向翻页同一套判定：
 * 顺向一甩任何距离都提交，回甩任何距离都取消，否则按走过的舞台比例决定。
 */
export function shortsSwipeTargetIndex(
  index: number,
  length: number,
  dragOffset: number,
  velocity: number,
  stageHeight: number,
): number | null {
  if (length <= 1 || index < 0 || index >= length || dragOffset === 0) return null;
  const advancing = dragOffset < 0;
  const fling = SHORTS_SWIPE_FLING_VELOCITY_PX_PER_MS;
  const flingForward = advancing ? velocity <= -fling : velocity >= fling;
  const flingBack = advancing ? velocity >= fling : velocity <= -fling;
  let commit: boolean;
  if (flingForward) commit = true;
  else if (flingBack) commit = false;
  else {
    commit = Math.abs(shortsSwipeProgress(dragOffset, stageHeight)) >= SHORTS_SWIPE_COMMIT_PROGRESS;
  }
  if (!commit) return null;
  const nextIndex = index + (advancing ? 1 : -1);
  return nextIndex < 0 || nextIndex >= length ? null : nextIndex;
}

/** 释放后覆盖剩余距离所需的时长（ms）：延续手势而不是播一段固定动画。 */
export function shortsSwipeSettleDuration(distance: number, velocity: number): number {
  const remaining = Math.abs(distance);
  if (remaining < 1) return 0;
  const speed = Math.min(
    SHORTS_SWIPE_SETTLE_MAX_SPEED,
    Math.max(SHORTS_SWIPE_SETTLE_MIN_SPEED, Math.abs(velocity)),
  );
  return Math.round(
    Math.min(SHORTS_SWIPE_SETTLE_MAX_MS, Math.max(SHORTS_SWIPE_SETTLE_MIN_MS, remaining / speed)),
  );
}

/** 把条带定位到指定条目。 */
export function shortsTrackOffset(index: number, stageHeight: number): number {
  const normalized = Math.max(0, index);
  const height = Math.max(0, stageHeight);
  return normalized === 0 || height === 0 ? 0 : -normalized * height;
}

/**
 * 当前下标周围需要挂载的条目下标（含自身）。
 *
 * 只挂载三个：上一条、当前、下一条。相邻条目必须真实挂载，否则跟手拖动时
 * 手指下方是空白 —— 那正是「滑动不跟手」的观感来源。再多挂就是白付封面图的
 * 解码与布局开销，滑动过程中看不到第二条之外的内容。
 */
export function shortsMountedIndexes(index: number, length: number): number[] {
  if (length <= 0) return [];
  const clamped = Math.max(0, Math.min(index, length - 1));
  const first = Math.max(0, clamped - 1);
  const last = Math.min(length - 1, clamped + 1);
  const indexes: number[] = [];
  for (let value = first; value <= last; value += 1) indexes.push(value);
  return indexes;
}

/**
 * 该在什么时候拉下一页。
 *
 * story feed 单批只给 4~5 条、后端一页串行取两批（约 9 条），而竖屏消费一次只看
 * 一条：等滑到最后一条再拉必然要等。剩余不足这个数就提前补，让下一条永远已在手上。
 */
export const SHORTS_PREFETCH_REMAINING = 3;

export function shortsShouldFetchMore(
  index: number,
  length: number,
  hasNextPage: boolean,
  isFetching: boolean,
): boolean {
  if (!hasNextPage || isFetching || length === 0) return false;
  return length - index - 1 <= SHORTS_PREFETCH_REMAINING;
}

// ---------------------------------------------------------------------------
// 双播放器槽位
// ---------------------------------------------------------------------------

/**
 * 两个播放器槽位的标识。
 *
 * 它们是**位置**而不是「当前/下一个」的角色：两个槽位轮换承担活动与预热，
 * 因此不能叫 `current` / `next` —— 那两个名字会在角色交换的那一刻变成谎言。
 */
export type ShortsSlotId = "a" | "b";

/** 滑动方向：1 向下（看更新的一条），-1 向上（回看）。 */
export type ShortsSwipeDirection = 1 | -1;

/**
 * 预热该落在哪一条。
 *
 * 顺着当前方向的那一条优先；到边界就回头取另一侧（在最后一条上，向下无路可走，
 * 但向上那条同样值得预热 —— 用户随时可能回滑）。只有一条时没有可预热的邻居。
 */
export function shortsWarmIndex(
  index: number,
  length: number,
  direction: ShortsSwipeDirection,
): number | null {
  if (length <= 1 || index < 0 || index >= length) return null;
  const forward = index + direction;
  if (forward >= 0 && forward < length) return forward;
  const backward = index - direction;
  if (backward >= 0 && backward < length) return backward;
  return null;
}

/** 两个槽位各自持有哪一条；null 表示该槽位空着。 */
export type ShortsSlotAssignments = Record<ShortsSlotId, number | null>;

export type ShortsSlots = {
  held: ShortsSlotAssignments;
  /** 承载当前条目的槽位。 */
  active: ShortsSlotId;
};

/**
 * 换片后的槽位分配。
 *
 * 角色交换而非「谁空闲谁上」：被提升的是**刚才在预热的那一个**，它已经取过流、
 * 已经缓冲好，因此换片不需要重新取流也不需要重建播放器。刚被换下的那个接着去
 * 预热新的邻居 —— 它手上的旧播放器正好用来换源，同样不必重建。
 *
 * 幂等：目标与预热目标都没变时返回**原对象**，调用方因此可以直接把它放进
 * 依赖数组而不触发多余的重跑。
 */
export function shortsNextSlots(
  index: number,
  length: number,
  direction: ShortsSwipeDirection,
  current: ShortsSlots,
): ShortsSlots {
  if (length <= 0 || index < 0 || index >= length) return current;
  const warm = shortsWarmIndex(index, length, direction);
  // 活动槽优先保持不变：同一条仍在播时（重渲染、视口变化）不该换手。
  const active: ShortsSlotId =
    current.held[current.active] === index
      ? current.active
      : current.held.a === index
        ? "a"
        : current.held.b === index
          ? "b"
          : current.active === "a"
            ? "b"
            : "a";
  const idle: ShortsSlotId = active === "a" ? "b" : "a";
  if (current.held[active] === index && current.held[idle] === warm) return current;
  return { held: { a: active === "a" ? index : warm, b: active === "b" ? index : warm }, active };
}

/**
 * 下一次滑动的方向。
 *
 * 只在真的换了条时更新：同一个方向连续滑动要一直顺着它预热，而回滑一次就把
 * 预热翻到另一侧。
 */
export function shortsPreloadDirection(
  index: number,
  nextIndex: number,
  current: ShortsSwipeDirection,
): ShortsSwipeDirection {
  if (nextIndex > index) return 1;
  if (nextIndex < index) return -1;
  return current;
}

/** 槽位面板在条带里的位置（百分比字符串），与封面面板同一套坐标系。 */
export function shortsSlotTop(held: number | null): string {
  return `${Math.max(0, held ?? 0) * 100}%`;
}

/**
 * 挂载窗口里哪些下标由槽位面板承担。
 *
 * 其余下标渲染封面占位：它们只需要有画面参与平移，不需要能播。
 */
export function shortsSlotCoveredIndexes(slots: ShortsSlots): Set<number> {
  const covered = new Set<number>();
  for (const value of [slots.held.a, slots.held.b]) {
    if (value != null) covered.add(value);
  }
  return covered;
}

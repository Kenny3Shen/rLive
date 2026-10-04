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

import { videoDimensionAspect } from "@/shared/videoDimension";
import type { VideoDimension, VideoItem } from "@/shared/types/video";

/** 短视频平台选择页。刻意不挂在 `/video` 下，避免侧栏「视频」跟着高亮。 */
export const SHORTS_PATH = "/shorts";
export const BILIBILI_SHORTS_PATH = "/shorts/bilibili";
export const DOUYIN_SHORTS_PATH = "/shorts/douyin";

/**
 * 进入短视频流时的种子参数：以这条 `bvid` 为起点。
 *
 * 由播放页的「短视频」入口带上（见 `shortsPath`）。带种子时上游把该稿件排在首位
 * 并换出一组与黏性头部不重叠的窗口；不带则首屏就是上游按账号给的默认窗口。
 */
export const SHORTS_SEED_PARAM = "seed";

/**
 * B 站推荐流链接。`seedBvid` 给定时以该稿件为起点，否则进入 `/shorts/bilibili`
 * （首屏不带种子）。平台选择页始终使用 `SHORTS_PATH`。
 *
 * 只编码 bvid：`encodeURIComponent` 对 `BV` 串是恒等的，写上是为了不把
 * 「参数值来自别处」这条假设留成隐患。
 */
export function shortsPath(seedBvid?: string | null): string {
  const bvid = seedBvid?.trim();
  return bvid ? `${BILIBILI_SHORTS_PATH}?${SHORTS_SEED_PARAM}=${encodeURIComponent(bvid)}` : BILIBILI_SHORTS_PATH;
}

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
  return videoDimensionAspect(dimension);
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
 * 底部安全区的 CSS 表达式。
 *
 * 原生注入的 `--android-safe-area-bottom` 优先于 `env(safe-area-inset-bottom)`：
 * Android WebView 的 `env()` 会读成 0（`MainActivity` 因此用
 * `getInsetsIgnoringVisibility` 把真值写成 CSS 变量，见 `styles.css` 里同一套写法）。
 * 直接用 `env()` 的后果是底部操作栏压在系统手势指示条下面 —— 手势条会吃掉那一段的
 * 触摸。沉浸路由不渲染底部导航，这一段让位只能由本页自己做。
 *
 * 保留 `env()` 作为回退：旧 APK 没有那个变量，浏览器里也没有。
 *
 * 顶部**没有**对应常量：状态栏由应用外壳统一让位（`.app-shell` 的 `padding-top`，
 * 见 `styles.css`），短视频视口的顶边就落在状态栏下沿。这一层再消费一次顶部安全区
 * 会把控制栏与画面又下推一条状态栏高度，中间空出一条谁都不用的黑带 —— 与画面内
 * HUD 把 `--player-safe-area-top` 钉成 `0px` 是同一条约定。
 */
export const SHORTS_SAFE_AREA_BOTTOM =
  "var(--android-safe-area-bottom, env(safe-area-inset-bottom))";

/**
 * 顶部控制栏的高度（px）。
 *
 * 就是这一条的全部高度：栏顶紧贴视口顶边（即状态栏下沿，外壳已让位），不再叠加
 * 顶部安全区。
 *
 * 它同时是弹幕首轨的基准：弹幕从它的下沿开始飘（见
 * `SHORTS_DANMAKU_TOP_OFFSET_PX`），不随画面框落在哪里而变。
 */
export const SHORTS_TOP_BAR_HEIGHT_PX = 52;

/**
 * 弹幕起始纵坐标（px），相对画面区顶边。
 *
 * 画面区顶边就是视口顶边（状态栏由外壳让位），顶部控制栏是浮层、压在画面区顶部
 * 这么高一条上。弹幕层因此不从画面框顶边起算 —— 横屏源的画面框落在屏幕偏上处，
 * 若按画面框算，首轨会跟着掉到画面里、离控制栏一截；按画面区算则恒为「控制栏
 * 下沿」这一条线，竖屏与横屏两个画幅一致。
 *
 * 别名而不是直接用上面那个常量，是因为两者的含义在概念上可以分开 ——
 * 「控制栏多高」与「弹幕从哪开始」只是此刻恰好相等，后者若要再留一点余量，改这里
 * 就够，不必去动布局契约。
 */
export const SHORTS_DANMAKU_TOP_OFFSET_PX = SHORTS_TOP_BAR_HEIGHT_PX;

/**
 * 短视频弹幕相对全局字号的缩放。
 *
 * 字号设置是全应用一份（直播间、播放页、录制回放共用），而竖屏舞台的观感与它们
 * 不同：画面占满整块视口，同样的 20/16px 在这块小舞台上明显偏大、一行放不下几个
 * 字。缩放而不是另存一份默认值，是为了让设置里那根滑杆在短视频里照样有效 ——
 * 用户在设置页调大字号，这里跟着变大，只是整体比别的表面小一档。
 *
 * 0.85 取「看得出小一点、又不用改设置」的幅度：桌面默认 20 → 17px，移动端
 * 默认 16 → 14px。下限仍由 `clampDanmuFontSize` 兜住（12px），滑杆拉到最小时
 * 不会被缩到读不出来。
 */
export const SHORTS_DANMAKU_FONT_SCALE = 0.85;

/**
 * 键盘左右方向键的单次跳转步长（秒）。
 *
 * 与播放页的快捷键同一口径：短视频普遍只有几十秒，5 秒是「跳过一小段」而不是
 * 「跳到别处」。上下方向键仍归换片，两者不在同一根轴上。
 */
export const SHORTS_SEEK_KEY_STEP_SECONDS = 5;

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
 * 横屏（与方形）源顶部的留白占全部留白的比例。
 *
 * 1/4 而不是 0（贴顶）或 1/2（居中）：贴顶会让 16:9 的画面紧贴在顶部控制栏下面、
 * 下方空掉大半个屏幕，而完全居中正是这次要改掉的观感。「偏上一点」是两者之间最稳
 * 的落点，也不随视口高度变化（留白按比例分配，同一条视频在不同机型上落在同一相对
 * 位置）。
 */
export const SHORTS_LANDSCAPE_FRAME_TOP_BIAS = 1 / 4;

/**
 * 画面框在画面区里的纵向落点（px，相对画面区顶边）。
 *
 * 两种画幅都不再垂直居中，但理由不同：
 *
 * - **竖屏源（aspect < 1）贴顶**：手机视口比 9:16 更长（9:19.5），居中会在画面
 *   **上方**留一条黑边，而那一段正是状态栏之下最该被画面占满的位置 —— 让出来的
 *   空隙归下方，那里本来就要放操作栏。
 * - **横屏与方形源（aspect ≥ 1）偏顶部**：16:9 的画面在竖屏视口里只占中间一小条，
 *   完全居中会让它浮在屏幕正中央、上下各留一大片背景；顶部留白取全部留白的
 *   `SHORTS_LANDSCAPE_FRAME_TOP_BIAS`（1/4），画面因此落在屏幕偏上处，下方那段
 *   正好留给信息与评论浮层。
 *
 * 判据取宽高比而不是「留边有多少」：后者随视口变化，同一条视频在手机与桌面上会得到
 * 不同的构图，换设备就换画法。方形归到横屏一侧 —— 它没有「竖屏要顶格」的诉求。
 * 宽高比未知时画面框就等于画面区（没有留白），偏移自然是 0。
 *
 * 返回值恒在 `[0, 留白]` 内：既不会把画面推到画面区之外，也不会超过全部留白。
 */
export function shortsFrameTop(
  frameHeight: number,
  areaHeight: number,
  aspect: number | null,
): number {
  if (!(areaHeight > 0) || !(frameHeight > 0)) return 0;
  const slack = areaHeight - frameHeight;
  if (!(slack > 0)) return 0;
  const bias =
    aspect && aspect >= 1 && Number.isFinite(aspect) ? SHORTS_LANDSCAPE_FRAME_TOP_BIAS : 0;
  return Math.min(slack, slack * bias);
}

/**
 * 页面层控件要对齐的「画面列」宽度（px）。
 *
 * 宽屏上竖屏画面会收成居中的竖卡（`shortsMediaFrame` 按高度内切），而顶栏、信息/
 * 评论、换片箭头与进度条如果还按**视口**的边摆放，就会与画面隔着一大片黑，读起来
 * 像两个不相干的层。这里给出画面框的宽度，让那几个控件按它收窄并居中。
 *
 * 返回 0 表示「不需要收窄」：画面框与画面区同宽（竖屏手机上就是这种），或者两侧
 * 剩下的空隙不够窄到值得收（画面几乎铺满时，收窄反而会把控件挤到画面之外）。
 * 留一个像素的容差是因为 `clientWidth` 取整，「铺满」时画面框可能比画面区小不到
 * 1px。
 */
export const SHORTS_CHROME_MIN_SIDE_INSET_PX = 48;

export function shortsChromeColumn(frameWidth: number, areaWidth: number): number {
  if (!(frameWidth > 0) || !(areaWidth > 0)) return 0;
  return areaWidth - frameWidth >= SHORTS_CHROME_MIN_SIDE_INSET_PX * 2 ? frameWidth : 0;
}

/**
 * 允许为「铺满」裁掉的最大比例。
 *
 * 两个宽高比的相对差值超过这个数就不再裁切，改回等比留边。取 0.1 是照真实机型的
 * 需求量定的（画面区 = 短视频视口高 − 底栏 59px − 底部安全区，9:16 源；视口高已由
 * 外壳的 `padding-top` 扣掉状态栏）：
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
 * 七成），必须留边（见 `shortsFrameTop` 的「横屏偏顶部」）。把判据写成「竖屏 + 差值够小」而不是
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
 * 顶部按钮的尺寸基准。
 *
 * 取 40px，触摸设备抬到 44px —— 与底部操作栏那颗按钮（`size-10` 加基础组件的
 * `[@media(pointer:coarse)]:min-h-11`）以及它左边的弹幕输入框完全同高。
 *
 * 播放页与直播页也是这个做法：顶栏 HUD 与底栏控件共用同一套尺寸，一条画面上不会
 * 出现「上面比下面大一圈」。只收窄 `--media-control-size`，不动 `--media-scale-unit`
 * （进度条与它的悬停预览挂在那个变量上）。
 *
 * B 站与抖音两个竖屏流共用这一份：两处顶栏按钮的尺寸契约是同一条，各留一份常量
 * 会在改其中一处时悄悄分叉。
 */
export const SHORTS_TOP_CONTROLS_CLASS =
  "media-skin [--media-control-size:2.5rem] [@media(pointer:coarse)]:[--media-control-size:2.75rem]";

/**
 * 跨页去重后的短视频条目。
 *
 * story feed 无游标：翻页就是「再拉一批轮换内容」，后端已按批去重，但跨页重复
 * 仍会发生（轮换由服务端时间轴推进，不保证不回头）。这里同时丢掉缺取流键的条目 ——
 * 竖屏舞台没有「先取详情补 cid」的中间态，拿不到 cid 的条目直接不该进流。
 */
type ShortsFeedPage = { items: readonly VideoItem[] };

/**
 * 追加时只去重新页；刷新、替换或截断页序列时重建，旧视图数组不会被原位修改。
 *
 * `isBlocked` 是 UP 主屏蔽名单的判定，**在合并这一步**过滤而不是在渲染前：
 * 补货条件是「当前下标离尾部还剩几条」（`shortsShouldFetchMore`），若被屏蔽的
 * 条目留在视图数组里，它们会一直占着下标、预取窗口永远凑不满，竖屏会卡在
 * 「滑到末尾却没有下一条」。在合并处丢掉则下标与预取窗口照旧。
 *
 * 判定的身份是**回调**而不是 `Set`：名单可能在流已经加载之后才变（用户刚在
 * 别的表面屏蔽了某人），调用方每次渲染传入的闭包必须是最新的。
 */
export function createShortsFeedMerger(isBlocked?: (item: VideoItem) => boolean) {
  let previous: readonly ShortsFeedPage[] = [];
  let seen = new Set<string>();
  let merged: VideoItem[] = [];
  return (pages: readonly ShortsFeedPage[]): VideoItem[] => {
    if (pages.length < previous.length || previous.some((page, index) => pages[index] !== page)) {
      previous = [];
      seen = new Set();
      merged = [];
    }
    if (pages.length === previous.length) return merged;
    const added: VideoItem[] = [];
    for (let index = previous.length; index < pages.length; index++) {
      for (const item of pages[index]!.items) {
        if (!item.bvid || !item.cid || item.cid <= 0 || seen.has(item.bvid)) continue;
        seen.add(item.bvid);
        if (isBlocked?.(item)) continue;
        added.push(item);
      }
    }
    previous = pages.slice();
    if (added.length) merged = [...merged, ...added];
    return merged;
  };
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
export const SHORTS_SWIPE_SETTLE_MIN_MS = 150;
export const SHORTS_SWIPE_SETTLE_MAX_MS = 320;
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

/**
 * 换片收尾的缓动曲线。
 *
 * 刻意不复用共享的 `SWIPE_SETTLE_EASING`（`EASE_OUT`）：横向翻页是一整屏的位移，
 * 需要温和的减速；短视频换片只有一条画面的行程，且上面叠了纵深缩放，因此收尾要在
 * 释放点更早离开、更快落定，避免「滑完了还在慢悠悠地动」。
 */
export const SHORTS_SWIPE_SETTLE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/** 换片纵深：邻条后退的缩放比例与淡出比例（相对 1 的最大偏差）。 */
export const SHORTS_DEPTH_SCALE = 0.08;
export const SHORTS_DEPTH_FADE = 0.5;

/**
 * 一个面板相对视口中心的纵深。
 *
 * `distance` 是面板中心离视口中心的距离，以舞台高为单位（0 = 正在看的那条）。
 * 返回的 `scale` / `opacity` 直接写到面板的内联样式上：换片时离场的一条后退并
 * 淡出、入场的一条浮上来，给平移叠一层纵深。
 *
 * 两个偏差都封顶在 `distance = 1`，因此再远的条目也不会缩成一片 —— 它们本来就在
 * 视口外，重要的是从边缘进入时的手感，而不是远处的精确值。
 */
export function shortsPanelDepth(distance: number): { scale: number; opacity: number } {
  if (!(distance > 0)) return { scale: 1, opacity: 1 };
  const bounded = Math.min(1, distance);
  return {
    scale: 1 - SHORTS_DEPTH_SCALE * bounded,
    opacity: 1 - SHORTS_DEPTH_FADE * bounded,
  };
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
 * 手指下方是空白 —— 那正是「滑动不跟手」的观感来源。再多挂就是白付一块舞台的
 * 测量与布局开销，滑动过程中看不到第二条之外的内容。
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
// 三播放器槽位
// ---------------------------------------------------------------------------

/**
 * 三个播放器槽位的标识。
 *
 * 它们是**位置**而不是「当前/下一个」的角色：槽位轮换承担活动与预热，
 * 因此不能叫 `current` / `next` —— 那两个名字会在角色交换的那一刻变成谎言。
 *
 * 三个槽位固定承担「上一条 / 当前 / 下一条」（见 `shortsSlotRole`），换片时按
 * `index % 3` 轮转：下标每前进一位，上一条的槽位就被改成新的下一条。
 */
export type ShortsSlotId = "a" | "b" | "c";

/** 槽位总数。轮转取模与「哪些下标被槽位覆盖」都按它算。 */
export const SHORTS_SLOT_COUNT = 3;

/** 所有槽位标识，顺序稳定。页面按它渲染槽位面板。 */
export const SHORTS_SLOT_IDS: readonly ShortsSlotId[] = ["a", "b", "c"];

/**
 * 槽位相对当前条目承担的角色。
 *
 * - `"current"`：正在播的那一条。
 * - `"next"` / `"prev"`：两个方向的邻居，各自预热到 `canplay` 待命。
 */
export type ShortsSlotRole = "current" | "next" | "prev";

/**
 * 某个槽位在给定下标下该承担哪个角色。
 *
 * 取模轮转而不是查表：下标前进一位时 `index % 3` 跟着走一格，于是原来的
 * `prev` 变成 `current`、原来的 `current` 变成 `next`、原来的 `next` 被改派
 * 去预热新的下一条 —— 换片因此**不换手、不重建播放器**（见 `shortsNextSlots`）。
 */
export function shortsSlotRole(index: number, slotId: ShortsSlotId): ShortsSlotRole {
  const offset =
    (SHORTS_SLOT_IDS.indexOf(slotId) - (index % SHORTS_SLOT_COUNT) + SHORTS_SLOT_COUNT) %
    SHORTS_SLOT_COUNT;
  return offset === 0 ? "current" : offset === 1 ? "next" : "prev";
}

/**
 * 承担「当前」角色的槽位。
 *
 * 与 `shortsSlotRole` 同一套取模，只是反着查：给定下标返回该由谁播。
 */
export function shortsActiveSlot(index: number): ShortsSlotId {
  return SHORTS_SLOT_IDS[index % SHORTS_SLOT_COUNT]!;
}

/** 三个槽位各自持有哪一条；null 表示该槽位空着。 */
export type ShortsSlotAssignments = Record<ShortsSlotId, number | null>;

export type ShortsSlots = {
  held: ShortsSlotAssignments;
  /** 承载当前条目的槽位。 */
  active: ShortsSlotId;
};

/**
 * 换片后的槽位分配。
 *
 * 三个槽位按 `index % 3` 固定承担「上一条 / 当前 / 下一条」，换片时**轮转**：
 * 下标前进一位，当前槽位跟着走一格，于是刚播完的那条留在 `prev`、刚预热好的
 * 那条升为 `current`，只有原来 `prev` 的那个槽位被改派去预热新的下一条 —— 它
 * 手上的旧播放器正好用来换源，同样不必重建。
 *
 * 两个邻居同时预热，因此**回滑与前进同样命中**：任一个方向都不必重新取流，
 * 分配也就不需要滑动方向这个输入。
 *
 * 幂等：三个槽位的持有都没变时返回**原对象**，调用方因此可以直接把它放进
 * 依赖数组而不触发多余的重跑。
 */
export function shortsNextSlots(
  index: number,
  length: number,
  current: ShortsSlots,
): ShortsSlots {
  if (length <= 0 || index < 0 || index >= length) return current;

  /**
   * 按角色取条目：`next` / `prev` 就是下标加减一，越界即无。
   *
   * 角色到槽位的对应是固定的（item j → 槽位 j % 3），因此这里只按角色取下标，
   * 不按「顺方向优先」排序 —— 后者是给单预热目标用的，用在槽位分配上会让边界处
   * 仅剩的那一个邻居错派给另一侧的槽位。
   */
  const target = (role: ShortsSlotRole): number | null => {
    const value = role === "current" ? index : role === "next" ? index + 1 : index - 1;
    return value >= 0 && value < length ? value : null;
  };

  const active = shortsActiveSlot(index);
  const held: ShortsSlotAssignments = { a: null, b: null, c: null };
  for (const slotId of SHORTS_SLOT_IDS) {
    held[slotId] = target(shortsSlotRole(index, slotId));
  }

  const unchanged =
    current.active === active &&
    current.held.a === held.a &&
    current.held.b === held.b &&
    current.held.c === held.c;
  return unchanged ? current : { held, active };
}

/** 槽位面板在条带里的位置（百分比字符串），与相邻占位面板同一套坐标系。 */
export function shortsSlotTop(held: number | null): string {
  return `${Math.max(0, held ?? 0) * 100}%`;
}

/**
 * 挂载窗口里哪些下标由槽位面板承担。
 *
 * 其余下标渲染空舞台占位：它们只需要有一块黑底参与平移，不需要能播。
 */
export function shortsSlotCoveredIndexes(slots: ShortsSlots): Set<number> {
  const covered = new Set<number>();
  for (const value of Object.values(slots.held)) {
    if (value != null) covered.add(value);
  }
  return covered;
}

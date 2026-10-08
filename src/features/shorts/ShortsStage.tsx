import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import { Video } from "@videojs/react/video";
import { SpinnerIcon } from "@videojs/react/icons";
import { BufferingIndicator } from "@/components/videojs/ui/buffering-indicator";
import { PlayButton } from "@/components/videojs/ui/play-button";
import { ShortsStagePlayer } from "./shortsStagePlayer";
import { VideoDanmakuLayer } from "@/features/video/VideoDanmakuLayer";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn, normalizeImageUrl } from "@/lib/utils";
import type { VideoItem } from "@/shared/types/video";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_DANMAKU_FONT_SCALE,
  SHORTS_DANMAKU_TOP_OFFSET_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  shortsFrameFill,
  shortsFrameTop,
  shortsChromeColumn,
  shortsMediaAspect,
  shortsMediaFrame,
} from "./shortsFeed";
import type { ShortsDanmakuState } from "./useShortsDanmaku";
import type { ShortsPlaybackState, ShortsSlotMode } from "./useShortsPlayback";

/**
 * 画面区域自身的像素尺寸。
 *
 * 用带清理函数的 callback ref 而不是 `useLayoutEffect` + `useRef`：ref 回调在
 * 节点挂载的那一刻就跑，首帧即可拿到尺寸，不会先按 0 画一帧再纠正。
 */
function useShortsStageSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const apply = () => {
      const { clientWidth, clientHeight } = node;
      setSize((current) =>
        current.width === clientWidth && current.height === clientHeight
          ? current
          : { width: clientWidth, height: clientHeight },
      );
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { size, measure };
}

/**
 * 画面区域：视口顶边之下、底部操作栏之上的那块矩形。
 *
 * 用 CSS 表达而不是把安全区读成数字：读数字要么靠探针元素、要么靠
 * `getComputedStyle`，两者都会在系统栏变化时慢一帧。这里只需要「画面不许越过
 * 这两条线」，交给 CSS 表达最直接，JS 只量结果。
 *
 * 底部安全区走 `SHORTS_SAFE_AREA_BOTTOM`（原生注入的变量优先、`env()` 兜底）而不是裸
 * `env()`：Android WebView 的 `env(safe-area-inset-*)` 会读到 0，本项目因此由
 * `MainActivity` 注入 `--android-safe-area-*`。裸 `env()` 在那里等于不留安全区，
 * 底部操作栏会被系统手势条压住。
 *
 * 底部让位是硬性的：操作栏（进度条 + 弹幕输入 + 几个按钮）占真实空间而不是浮在
 * 画面上，因此画面可用高度必须先减掉它，否则输入框会盖住画面底部。
 *
 * 顶部相反，一点不减：状态栏已由 `.app-shell` 的 `padding-top` 统一预留，短视频
 * 视口的顶边就是状态栏下沿，这里再减一次会在顶部空出一条状态栏高的黑带
 * （见 `shortsFeed` 的安全区注释）。顶栏是浮层，压在画面顶部这一条上，弹幕另有
 * 起始线让位（见 `--video-danmaku-top`）。
 */
const SHORTS_MEDIA_AREA_STYLE = {
  top: 0,
  bottom: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + ${SHORTS_SAFE_AREA_BOTTOM})`,
} as const;

/**
 * 画面框的定位样式：等比内切出的尺寸 + 纵向落点。
 *
 * 尺寸还没量到时退回铺满，避免首帧出现 0×0 的空框；纵向落点用 `marginTop` 而不是
 * flex 对齐类，因为它是留白的几分之几这个连续值。
 */
function shortsFrameStyle(frame: { width: number; height: number }, offset: number) {
  return frame.width > 0 && frame.height > 0
    ? { width: `${frame.width}px`, height: `${frame.height}px`, marginTop: `${offset}px` }
    : { width: "100%", height: "100%" };
}

/** 画面框是否小于可用区域（桌面上的居中卡片形态）：只有这时才给圆角。 */
function shortsFrameInset(
  frame: { width: number; height: number },
  area: { width: number; height: number },
): boolean {
  if (!(frame.width > 0) || !(area.width > 0)) return false;
  return frame.width < area.width - 1 || frame.height < area.height - 1;
}

/**
 * 画面框的几何：铺满还是等比留边，以及它在画面区里的纵向落点。
 *
 * 两种形态共用一个出口，因为舞台与相邻条目的空舞台占位必须得到**完全相同**的矩形 ——
 * 否则换片时画面会从一个构图跳到另一个构图。纵向落点也算在这份几何里，理由相同：
 * 换片时黑底与视频不能一个在中间、一个偏上。
 */
function useShortsFrameGeometry(aspect: number | null, area: { width: number; height: number }) {
  const fill = shortsFrameFill(area.width, area.height, aspect);
  // 铺满时画面框就是画面区，裁切交给 CSS 的 `object-cover`：这里不必自己算裁掉多少，
  // 浏览器按同一套居中裁切规则处理，缩放与像素对齐也由合成器负责。
  const frame = fill ? area : shortsMediaFrame(area.width, area.height, aspect);
  // 横屏源偏顶部（不再垂直居中）：偏移是个比例值（留白的 1/4），
  // `align-items` 表达不了，因此写成 `margin-top`。
  const offset = shortsFrameTop(frame.height, area.height, aspect);
  return { fill, frame, offset, inset: shortsFrameInset(frame, area) };
}

/**
 * 弹幕列：宽度等于画面框、水平居中，纵向从顶部控制栏下沿到画面区底边。
 *
 * 弹幕**不在画面框里**，这是这次修复的核心。画面框会随画幅落在不同高度（竖屏贴顶、
 * 横屏偏上），而弹幕的起始轨道是固定的一条线：顶部控制栏的下沿。挂在画面框里就只能
 * 从画面框顶边起算，横屏源上首轨会跟着画面一起掉到屏幕中部（改前的症状）。
 *
 * 宽度取画面框宽：桌面宽屏上画面收成居中的竖卡，弹幕跟着收在卡片那一列里，不会飘到
 * 两侧的黑边上。高度取到画面区底边而不是画面框底边：显示区域设置（`danmakuArea`）
 * 是按容器高度取比例的，容器若只到画面框底边，16:9 画面上方那段留白会把轨道全吃
 * 掉，画面里反而一条弹幕都看不到。
 */
function shortsDanmakuColumnStyle(frame: { width: number }): React.CSSProperties {
  return {
    top: `${SHORTS_DANMAKU_TOP_OFFSET_PX}px`,
    left: frame.width > 0 ? `calc(50% - ${frame.width / 2}px)` : 0,
    width: frame.width > 0 ? `${frame.width}px` : "100%",
    // 起始线已经由本层自己的 `top` 表达；`VideoDanmakuLayer` 读的那个变量在这里
    // 钉成 0，免得叠加两份偏移。
    "--video-danmaku-top": "0px",
  } as React.CSSProperties;
}

/**
 * 竖屏舞台：一条短视频的画面与弹幕层。
 *
 * 舞台挂在**槽位**上而不是条目上：三个槽位轮换承担活动与两个方向的预热，换片时角色交换，
 * 因此这里面对的是「同一个 `<video>` 上换了一条内容」而不是挂载/卸载。槽位面板
 * 的 key 恒定（`slot-a` / `slot-b` / `slot-c`），`<video>` 与 Video.js 实例因此跨换片存活 ——
 * 这就是「播放器复用」的落点。
 *
 * 相邻条目渲染 `ShortsBlankStage`（空舞台占位）：它们只需要有画面参与平移，不需要能播。
 * 一个槽位就是一个播放器实例加三条本机代理会话，为滑动跟手再多起一份是把上游
 * 取流成本翻倍，而滑动过程中相邻条目只要有画面占位。
 *
 * 这一层只剩「画面本身」：进度条、信息与评论入口都住在页面的固定层里（见
 * `ShortsPage`）—— 它们不该随条带平移，否则换片时会跟着画面一起滑走。
 */

export type ShortsStageItem = Pick<VideoItem, "title" | "cover" | "dimension"> &
  Partial<Pick<VideoItem, "aid" | "cid">>;

type ShortsStageProps = {
  /** 仅依赖展示字段；抖音不伪造 B 站 aid/cid，弹幕由能力参数控制。 */
  item: ShortsStageItem;
  playback: ShortsPlaybackState;
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * 这一轮的角色。`"warm"` 时不渲染弹幕层、点按层与两种状态指示：预热面板在屏幕
   * 外，且它所在的面板带 `inert`，点按层挂上去只会挨一次吃掉的点击。
   */
  mode: ShortsSlotMode;
  danmaku?: ShortsDanmakuState;
  /** 弹幕开关。未提供弹幕能力时不挂层；关掉时层仍在，仅不可见。 */
  danmakuVisible?: boolean;
  /** 手势进行中：此时禁掉点按，避免滑动尾声的合成 click 误暂停。 */
  gestureActive: boolean;
  /**
   * 画面点按的动作。
   *
   * 由页面提供而不是这里直接调 `playback.togglePlay`：长按倍速松手后浏览器仍会补一次
   * click，只有页面知道那一下该不该作废（它持有长按的抑制窗口）。
   */
  onSurfaceTap: () => void;
  /**
   * 把「页面层控件该多宽」上报给页面。
   *
   * 宽屏上画面会收成居中的竖卡，顶栏/信息/评论/换片箭头/进度条如果还按视口边摆放
   * 就会与画面隔着大片黑。舞台知道画面框的真实宽度（它自己量的），页面只负责用这个
   * 数字去收窄那几层控件。传 0 表示「铺满，控件退回通栏」。
   *
   * 只有活动舞台上报（`mode === "play"`）：预热槽位在屏幕外，它的画面框宽不是当前
   * 看到的那一条。
   */
  onChromeColumn?: (width: number) => void;
};

export function ShortsStage({
  item,
  playback,
  videoRef,
  mode,
  danmaku,
  danmakuVisible,
  gestureActive,
  onSurfaceTap,
  onChromeColumn,
}: ShortsStageProps) {
  const cid = item.cid ?? 0;
  const { size: area, measure } = useShortsStageSize();
  // 起播后以媒体自报画幅为准，起播前用列表下发的 dimension 定框。
  const aspect = shortsMediaAspect(item.dimension, playback.intrinsicSize);
  const { fill, frame, offset, inset } = useShortsFrameGeometry(aspect, area);
  const warming = mode !== "play";

  // 页面层控件的收窄宽度。只由活动舞台报，且只报「比画面区窄」的那些：铺满时给 0，
  // 页面据此退回通栏，手机竖屏的观感与从前完全一致。`useLayoutEffect` 在浏览器绘制前
  // 跑，宽屏第一帧就不会先画一遍通栏控件再跳成收窄 —— 那一下闪跳比不优化还显眼。
  useLayoutEffect(() => {
    if (mode !== "play") return;
    onChromeColumn?.(shortsChromeColumn(frame.width, area.width));
  }, [area.width, frame.width, mode, onChromeColumn]);

  const cover = normalizeImageUrl(item.cover);
  // `play` 与 `waiting` 不能证明首帧已出画；只认当前条目的帧回调。
  const awaitingFirstFrame = !playback.hasFrame;

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {/* 加载期间不留封面：模糊背景也是封面，让位给纯黑与转圈（见下方注释）。 */}
      <ShortsDynamicBackground cover={cover} visible={!awaitingFirstFrame} />
      <div
        ref={measure}
        data-slot="shorts-media-area"
        className="absolute inset-x-0 flex items-start justify-center"
        style={SHORTS_MEDIA_AREA_STYLE}
      >
        <div
          data-slot="shorts-frame"
          className={cn("relative shrink-0", inset && "overflow-hidden rounded-sm")}
          style={shortsFrameStyle(frame, offset) as React.CSSProperties}
        >
          {/*
            槽位直接显示视频，不叠加 Poster：预热只缓冲、不播放，store 的 `started`
            仍为 false。若按它显示封面，已经解码的首帧也会被挡住，换片时就会先闪
            封面再出画。首帧前由下方黑底遮挡层等待媒体就绪；只给 video 设置
            黑底不能盖住 WebView 的内置海报或复用槽位留下的旧帧。

            `BufferingIndicator` / `PlayButton` 仍通过 store 的 `waiting` / `paused`
            驱动。传输沿用自有的 `VideoJsPlayer`（dash.js），所以保留包住 `<video>`
            的 Player，为这两种状态指示提供上下文。
          */}
          <ShortsStagePlayer>
            <Video
              ref={videoRef}
              playsInline
              // 预热槽位不进 Tab 序：它在屏幕外，键盘用户不该能聚焦到一个看不见的
              // 媒体元素上（活动槽位保留默认的原生可聚焦行为）。
              tabIndex={warming ? -1 : undefined}
              className={cn(
                "absolute inset-0 size-full bg-black",
                // 铺满形态下画面框比源画幅「窄」或「矮」一点，多出来的部分居中裁掉；
                // 留边形态下画面框已经是源画幅的比例，`contain` 只是保险 —— 媒体自报
                // 画幅与列表下发的 dimension 不一致时，宁可留一圈黑边也不裁掉画面。
                fill ? "object-cover" : "object-contain",
              )}
            />

            {/*
              加载指示交给 Video.js 的 `BufferingIndicator`：它读播放器 store 的
              `waiting`（媒体已 starved 且未暂停），并自带 500ms 延迟 —— 短暂卡顿
              不会闪一下转圈。首帧前由下方独立的起播指示器接管，避免两颗转圈重叠。

              它必须在 `ShortsStagePlayer` 里：store 挂在槽位的 `<video>` 上，离开
              这个作用域读不到播放状态。

              图标尺寸走 `--media-icon-size` 令牌而不是硬写类名：转圈图标用的是
              `size-media-icon`（读这个变量），把变量设为 2rem 与下面那颗暂停图标
              对齐。后者的兜底是 `--media-spacing * 4.5`，在短视频视口的
              `--media-scale-unit: 1.2rem` 下只有 21.6px，比原来小一圈。
            */}
            {!warming && !awaitingFirstFrame && !playback.error && (
              <BufferingIndicator
                data-slot="shorts-buffering-indicator"
                style={{ "--media-icon-size": "2rem" } as React.CSSProperties}
              />
            )}

            {/*
              暂停/重播指示交给 Video.js 的 `PlayButton`：它按 store 的
              `paused` / `ended` 在播放、暂停、重播三套图标间切换，与播放页控制栏
              上的那颗是同一个组件。

              这里**只当指示器用**：外层 `pointer-events-none` 让点击穿透到下面的
              命中层，`tabIndex={-1}` 与 `aria-hidden` 把它排除出 Tab 序与读屏。
              播放状态的切换必须走页面的 `onSurfaceTap` —— 只有页面知道长按倍速抬手
              后浏览器补发的那次 click 该不该作废（见 `ShortsPage`）。

              尺寸走 `--media-control-size` / `--media-icon-size` 两个令牌而不是硬写
              类名：`Button` 基类的 `size-media-control` 与 PlayButton 内图标的
              `size-6` 都写死在组件里，用令牌是这套皮肤提供的缩放入口，且后代选择器
              覆盖图标不依赖工具类的生成顺序。

              条件里带 `paused` 而不是让组件自己藏：`PlayButton` 在播放中会显示暂停
              图标，而短视频播放中不该常驻一颗暂停按钮。`!playback.loading` 保留原
              行为 —— 换片取流期间尚未就绪，那时闪一下播放按钮是多余的。
            */}
            {!warming &&
              !awaitingFirstFrame &&
              playback.paused &&
              !playback.loading &&
              !playback.error && (
                <div
                  aria-hidden
                  data-slot="shorts-play-indicator"
                  className="pointer-events-none absolute inset-0 grid place-items-center [&_svg]:size-media-icon"
                  style={
                    {
                      "--media-control-size": "4rem",
                      "--media-icon-size": "2rem",
                    } as React.CSSProperties
                  }
                >
                  <PlayButton
                    tabIndex={-1}
                    className="bg-black/40 text-media-controls-foreground"
                  />
                </div>
              )}
          </ShortsStagePlayer>

          {/*
            黑底必须盖在媒体上方：无 poster 不等于无原生海报，换源前也可能保留旧帧。
            预热与失败时同样遮住；不卸载或隐藏 video，避免影响预热解码和逐帧回调。
          */}
          {awaitingFirstFrame && (
            <div
              aria-hidden
              data-slot="shorts-first-frame-mask"
              className="pointer-events-none absolute inset-0 bg-black"
            />
          )}

          {/*
            起播转圈：首帧到达前的黑屏上给一个「在加载」的明确信号。

            不直接用 `BufferingIndicator`：它读 store 的 `waiting`，起播前暂停时
            读不到。首帧后才挂载它，避免 play 先到、帧未到时两颗转圈同时出现。
            图标仍复用同一个 `SpinnerIcon` 与 `--media-icon-size` 令牌。

            只当指示器：`aria-hidden` + `pointer-events-none`，点按暂停仍由下面的
            命中层接管。
          */}
          {!warming && awaitingFirstFrame && !playback.error && (
            <div
              aria-hidden
              data-slot="shorts-loading-indicator"
              className="pointer-events-none absolute inset-0 grid place-items-center text-media-controls-foreground"
              style={{ "--media-icon-size": "2rem" } as React.CSSProperties}
            >
              <SpinnerIcon className="size-media-icon drop-shadow-media-icon" />
            </div>
          )}

          {!warming && playback.error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-8 text-center">
              <p className="text-sm text-white/90">{playback.error}</p>
              <Button variant="outline" size="sm" onClick={playback.retry}>
                重试
              </Button>
            </div>
          )}

          {/*
            点按暂停/播放的命中层：铺满画面框。

            只铺画面框而不是整个面板：画面之外是背景区与操作栏，点它们不该改变
            播放状态（与 YouTube Shorts 的桌面形态一致）。

            刻意是 div 而不是 button：铺满画面的按钮会进 Tab 序并被读屏当作一个
            巨大的控件，而它只是指针便利。键盘路径由 Space / K 承担（见 `ShortsPage`）。
          */}
          {!warming &&
            !playback.error && (
              // oxlint-disable-next-line click-events-have-key-events, no-static-element-interactions
              <div
                aria-hidden
                // 手势进行中不响应：Android WebView 在识别出的滑动之后仍可能补发 click。
                onClick={gestureActive ? undefined : onSurfaceTap}
                className="absolute inset-0"
              />
            )}
        </div>

        {/*
          弹幕层与画面框**平级**，不在它里面（见 `shortsDanmakuColumnStyle`）。

          挂在画面框里就只能从画面框顶边起算，而画面框会随画幅落在不同高度：横屏源
          偏上之后，首轨会跟着画面一起掉到屏幕中部、离顶部控制栏一截 —— 正是这次要
          修的问题。放在这里则起点恒为控制栏下沿，竖屏与横屏两个画幅一致。

          宽度仍跟着画面框收：桌面宽屏上画面是居中的竖卡，弹幕若按画面区通栏，
          会飘到卡片两侧的黑边上。

          关掉弹幕不卸载这一层，只把它设为不可见：调度照常走，重新打开时屏上就是一直
          开着会看到的那些弹幕。
        */}
        {danmaku && item.aid && !warming && (
          <div
            data-slot="shorts-danmaku-column"
            className="pointer-events-none absolute bottom-0"
            style={shortsDanmakuColumnStyle(frame)}
          >
            <VideoDanmakuLayer
              videoRef={videoRef}
              entries={danmaku.entries}
              active={danmakuVisible ?? false}
              // 竖屏舞台上飘屏弹幕不接受点按：这块画面的点按语义已经归暂停。
              interactive={false}
              cid={cid}
              aid={item.aid}
              title={item.title}
              fontSizeScale={SHORTS_DANMAKU_FONT_SCALE}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 画面框之外的背景：封面模糊放大。
 *
 * 默认**关闭**（`dynamicBackgroundEnabled`，见外观设置）。它只在画面框小于画面区时
 * 才看得见 —— 桌面上的居中竖卡两侧、横屏源的上下留边 —— 而手机上竖屏源现在多数会
 * 裁切铺满，那里根本没有它的位置。关掉时留边处是纯黑，也是播放器的常规画法。
 *
 * `visible` 为假时（首帧尚未到达）连它一起让位：那时画面区整块是空的，模糊封面
 * 会铺满全屏、被读成「加载封面」，而产品语义是加载期间只给黑屏与转圈。首帧出画后
 * 它照常显示在留边处 —— 那是这个设置本身的意图（留边不空着），不是加载占位。
 *
 * 恒定渲染而不按画幅分支：「画面框是否小于画面区」取决于视口比例，同一条视频在手机
 * 与桌面上的答案不同。
 */
function ShortsDynamicBackground({
  cover,
  visible,
}: {
  cover: string | undefined;
  visible: boolean;
}) {
  const enabled = useSettingsStore((state) => state.dynamicBackgroundEnabled);
  if (!enabled || !cover || !visible) return null;
  return (
    <img
      src={cover}
      alt=""
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-2xl saturate-150"
    />
  );
}

/**
 * 相邻条目的空舞台占位。
 *
 * 滑动时手指下方必须有真实内容 —— 那正是「跟手」的观感来源 —— 但相邻条目不该
 * 起播，也还没有可显示的首帧。这里给出一块与活动舞台完全相同的黑底几何（同一块
 * 画面区、同一套铺满/留边判定），因此换片时构图不发生跳变：黑底停在哪个矩形里，
 * 视频就在哪个矩形里出画。
 *
 * **刻意不画封面**：短视频的消费语义是「画面就是内容」，换片时先闪一张静图再出画
 * 反而像卡了一帧；加载期间黑屏加转圈（活动槽位里）就够。相邻条目也不会渲染模糊
 * 背景 —— 它同样是这张稿件的封面，同样只属于「已经在播」的舞台。
 *
 * 不画信息与操作入口：那些住在页面的固定层里，只描述**当前**条目。占位上再画
 * 一份会在滑动过程中出现两套信息。
 */
export function ShortsBlankStage({ item }: { item: Pick<ShortsStageItem, "dimension"> }) {
  const { size: area, measure } = useShortsStageSize();
  // 占位阶段没有媒体自报画幅，只有列表下发的 dimension。
  const aspect = shortsMediaAspect(item.dimension);
  const { frame, offset, inset } = useShortsFrameGeometry(aspect, area);
  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <div
        ref={measure}
        className="absolute inset-x-0 flex items-start justify-center"
        style={SHORTS_MEDIA_AREA_STYLE}
      >
        <div
          className={cn("relative shrink-0", inset && "overflow-hidden rounded-sm")}
          style={shortsFrameStyle(frame, offset) as React.CSSProperties}
        />
      </div>
    </div>
  );
}

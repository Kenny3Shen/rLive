import { Play } from "lucide-react";
import { useCallback, useState, type RefObject } from "react";
import { VideoDanmakuLayer } from "@/features/video/VideoDanmakuLayer";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn, normalizeImageUrl } from "@/lib/utils";
import type { VideoItem } from "@/shared/types/video";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_DANMAKU_TOP_OFFSET_PX,
  SHORTS_SAFE_AREA_BOTTOM,
  shortsFrameAlign,
  shortsFrameFill,
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
 * 画面框的定位样式：等比内切出的尺寸。
 *
 * 尺寸还没量到时退回铺满，避免首帧出现 0×0 的空框。
 */
function shortsFrameStyle(frame: { width: number; height: number }) {
  return frame.width > 0 && frame.height > 0
    ? { width: `${frame.width}px`, height: `${frame.height}px` }
    : { width: "100%", height: "100%" };
}

/**
 * 对齐语义 → flex 类名。
 *
 * `shortsFrameAlign` 刻意返回语义值（`"start"` / `"center"`）而不是类名：那份判定是
 * 可单测的纯几何，不该知道用的是 Tailwind 还是别的什么。映射放在使用它的这一层。
 */
const SHORTS_ALIGN_CLASS = {
  start: "items-start",
  center: "items-center",
} as const;

/** 画面框是否小于可用区域（桌面上的居中卡片形态）：只有这时才给圆角。 */
function shortsFrameInset(
  frame: { width: number; height: number },
  area: { width: number; height: number },
): boolean {
  if (!(frame.width > 0) || !(area.width > 0)) return false;
  return frame.width < area.width - 1 || frame.height < area.height - 1;
}

/**
 * 画面框的几何：铺满还是等比留边。
 *
 * 两种形态共用一个出口，因为舞台与相邻条目的封面占位必须得到**完全相同**的矩形 ——
 * 否则换片时画面会从一个构图跳到另一个构图。
 */
function useShortsFrameGeometry(aspect: number | null, area: { width: number; height: number }) {
  const fill = shortsFrameFill(area.width, area.height, aspect);
  // 铺满时画面框就是画面区，裁切交给 CSS 的 `object-cover`：这里不必自己算裁掉多少，
  // 浏览器按同一套居中裁切规则处理，缩放与像素对齐也由合成器负责。
  const frame = fill ? area : shortsMediaFrame(area.width, area.height, aspect);
  return { fill, frame, inset: shortsFrameInset(frame, area) };
}

/**
 * 竖屏舞台：一条短视频的画面与弹幕层。
 *
 * 舞台挂在**槽位**上而不是条目上：两个槽位轮换承担活动与预热，换片时角色交换，
 * 因此这里面对的是「同一个 `<video>` 上换了一条内容」而不是挂载/卸载。槽位面板
 * 的 key 恒定（`slot-a` / `slot-b`），`<video>` 与 Video.js 实例因此跨换片存活 ——
 * 这就是「播放器复用」的落点。
 *
 * 相邻条目渲染 `ShortsPoster`（封面占位）：它们只需要有画面参与平移，不需要能播。
 * 一个槽位就是一个播放器实例加三条本机代理会话，为滑动跟手再多起一份是把上游
 * 取流成本翻倍，而滑动过程中相邻条目只要有画面占位。
 *
 * 这一层只剩「画面本身」：进度条、信息与评论入口都住在页面的固定层里（见
 * `ShortsPage`）—— 它们不该随条带平移，否则换片时会跟着画面一起滑走。
 */

type ShortsStageProps = {
  item: VideoItem;
  playback: ShortsPlaybackState;
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * 这一轮的角色。`"warm"` 时不渲染弹幕层、点按层与暂停图标：预热面板在屏幕外，
   * 且它所在的面板带 `inert`，点按层挂上去只会挨一次吃掉的点击。
   */
  mode: ShortsSlotMode;
  danmaku: ShortsDanmakuState;
  /** 弹幕开关。关掉时不挂层。 */
  danmakuVisible: boolean;
  /** 手势进行中：此时禁掉点按，避免滑动尾声的合成 click 误暂停。 */
  gestureActive: boolean;
  /**
   * 画面点按的动作。
   *
   * 由页面提供而不是这里直接调 `playback.togglePlay`：长按倍速松手后浏览器仍会补一次
   * click，只有页面知道那一下该不该作废（它持有长按的抑制窗口）。
   */
  onSurfaceTap: () => void;
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
}: ShortsStageProps) {
  const cid = item.cid ?? 0;
  const { size: area, measure } = useShortsStageSize();
  // 起播后以媒体自报画幅为准，起播前用列表下发的 dimension 定框。
  const aspect = shortsMediaAspect(item.dimension, playback.intrinsicSize);
  const { fill, frame, inset } = useShortsFrameGeometry(aspect, area);
  const warming = mode !== "play";

  const cover = normalizeImageUrl(item.cover);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <ShortsDynamicBackground cover={cover} />
      <div
        ref={measure}
        data-slot="shorts-media-area"
        className={cn(
          "absolute inset-x-0 flex justify-center",
          SHORTS_ALIGN_CLASS[shortsFrameAlign(aspect)],
        )}
        style={SHORTS_MEDIA_AREA_STYLE}
      >
        <div
          data-slot="shorts-frame"
          className={cn("relative shrink-0", inset && "overflow-hidden rounded-sm")}
          style={
            {
              ...shortsFrameStyle(frame),
              // 弹幕从顶部控制栏下方开始飘，不从画面顶边开始：画面框的顶边就是
              // 视口顶边（状态栏下沿），而控制栏正好压在那一段上，不让位会让弹幕
              // 穿过返回按钮。
              "--video-danmaku-top": `${SHORTS_DANMAKU_TOP_OFFSET_PX}px`,
            } as React.CSSProperties
          }
        >
          {/* 封面占位：与画面同尺寸同裁切方式，盖到播放器真的出画为止。 */}
          {cover && (
            <img
              src={cover}
              alt=""
              aria-hidden
              className="pointer-events-none absolute inset-0 size-full object-cover"
            />
          )}
          <video
            ref={videoRef}
            playsInline
            // 预热槽位不进 Tab 序：它在屏幕外，键盘用户不该能聚焦到一个看不见的
            // 媒体元素上（活动槽位保留默认的原生可聚焦行为）。
            tabIndex={warming ? -1 : undefined}
            className={cn(
              "absolute inset-0 size-full",
              // 铺满形态下画面框比源画幅「窄」或「矮」一点，多出来的部分居中裁掉；
              // 留边形态下画面框已经是源画幅的比例，`contain` 只是保险 —— 媒体自报
              // 画幅与列表下发的 dimension 不一致时，宁可留一圈黑边也不裁掉画面。
              fill ? "object-cover" : "object-contain",
              // 出画前保持透明，让封面负责首帧观感；否则会闪一下黑底。
              playback.loading && "opacity-0",
            )}
          />
          {danmakuVisible && !warming && (
            <VideoDanmakuLayer
              videoRef={videoRef}
              entries={danmaku.entries}
              active={danmakuVisible}
              // 竖屏舞台上飘屏弹幕不接受点按：这块画面的点按语义已经归暂停。
              interactive={false}
              cid={cid}
              aid={item.aid}
              title={item.title}
            />
          )}

          {/* 预热槽位不画加载/错误/暂停指示：它在屏幕外，画面由封面占位。 */}
          {!warming && (playback.loading || playback.waiting) && !playback.error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Spinner className="size-8 text-white/90" aria-label="正在加载" />
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
          {/* 暂停图标：只在用户暂停时出现，加载中的转圈另有指示。 */}
          {!warming && playback.paused && !playback.loading && !playback.error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex size-16 items-center justify-center rounded-full bg-black/40">
                <Play className="size-8 text-white/90" aria-hidden />
              </span>
            </div>
          )}

          {/*
            点按暂停/播放的命中层：铺满画面框。

            只铺画面框而不是整个面板：画面之外是背景区与操作栏，点它们不该改变
            播放状态（与 YouTube Shorts 的桌面形态一致）。

            刻意是 div 而不是 button：铺满画面的按钮会进 Tab 序并被读屏当作一个
            巨大的控件，而它只是指针便利。键盘路径由 Space / K 承担（见 `ShortsPage`）。
          */}
          {!warming && (
            // oxlint-disable-next-line click-events-have-key-events, no-static-element-interactions
            <div
              aria-hidden
              // 手势进行中不响应：Android WebView 在识别出的滑动之后仍可能补发 click。
              onClick={gestureActive ? undefined : onSurfaceTap}
              className="absolute inset-0"
            />
          )}
        </div>
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
 * 恒定渲染而不按画幅分支：「画面框是否小于画面区」取决于视口比例，同一条视频在手机
 * 与桌面上的答案不同。
 */
function ShortsDynamicBackground({ cover }: { cover: string | undefined }) {
  const enabled = useSettingsStore((state) => state.dynamicBackgroundEnabled);
  if (!enabled || !cover) return null;
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
 * 相邻条目的封面占位。
 *
 * 滑动时手指下方必须有真实内容 —— 那正是「跟手」的观感来源 —— 但相邻条目不该
 * 起播。画面框用与活动舞台完全相同的几何（同一块画面区、同一套铺满/留边判定），
 * 因此换片时构图不发生跳变：封面停在哪个矩形里，视频就在那个矩形里出画。
 *
 * 不画信息与操作入口：那些住在页面的固定层里，只描述**当前**条目。占位上再画一份
 * 会在滑动过程中出现两套信息。
 */
export function ShortsPoster({ item }: { item: VideoItem }) {
  const cover = normalizeImageUrl(item.cover);
  const { size: area, measure } = useShortsStageSize();
  // 占位阶段没有媒体自报画幅，只有列表下发的 dimension。
  const aspect = shortsMediaAspect(item.dimension);
  const { frame, inset } = useShortsFrameGeometry(aspect, area);
  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <ShortsDynamicBackground cover={cover} />
      <div
        ref={measure}
        className={cn(
          "absolute inset-x-0 flex justify-center",
          SHORTS_ALIGN_CLASS[shortsFrameAlign(aspect)],
        )}
        style={SHORTS_MEDIA_AREA_STYLE}
      >
        <div
          className={cn("relative shrink-0", inset && "overflow-hidden rounded-sm")}
          style={shortsFrameStyle(frame)}
        >
          {cover && (
            <img
              src={cover}
              alt=""
              aria-hidden
              className="absolute inset-0 size-full object-cover"
            />
          )}
        </div>
      </div>
    </div>
  );
}

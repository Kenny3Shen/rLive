import { MessageSquare, Play } from "lucide-react";
import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { VideoDanmakuLayer } from "@/features/video/VideoDanmakuLayer";
import { formatVideoDuration } from "@/features/video/videoHistory";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import type { VideoItem } from "@/shared/types/video";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_DANMAKU_TOP_OFFSET_PX,
  SHORTS_SEEK_KEY_STEP_SECONDS,
  shortsMediaAspect,
  shortsMediaFrame,
  shortsSeekRatio,
  shortsSeekTime,
} from "./shortsFeed";
import type { ShortsDanmakuState } from "./useShortsDanmaku";
import type { ShortsPlaybackState } from "./useShortsPlayback";

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
 * 画面区域：顶部安全区之下、底部操作栏之上的那块矩形。
 *
 * 用 CSS `env()` 而不是把安全区读成数字：读数字要么靠探针元素、要么靠
 * `getComputedStyle`，两者都会在系统栏变化时慢一帧。这里只需要「画面不许越过
 * 这两条线」，交给 CSS 表达最直接，JS 只量结果。
 *
 * 底部让位是硬性的：操作栏（弹幕输入 + 三个按钮）占真实空间而不是浮在画面上，
 * 因此画面可用高度必须先减掉它，否则输入框会盖住画面底部。
 */
const SHORTS_MEDIA_AREA_STYLE = {
  top: "env(safe-area-inset-top)",
  bottom: `calc(${SHORTS_BOTTOM_BAR_HEIGHT_PX}px + env(safe-area-inset-bottom))`,
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

/** 画面框是否小于可用区域（桌面上的居中卡片形态）：只有这时才给圆角。 */
function shortsFrameInset(
  frame: { width: number; height: number },
  area: { width: number; height: number },
): boolean {
  if (!(frame.width > 0) || !(area.width > 0)) return false;
  return frame.width < area.width - 1 || frame.height < area.height - 1;
}

/**
 * 竖屏舞台：一条短视频的画面、弹幕层与画面内覆层。
 *
 * 只有活动条目会挂载这个组件（相邻条目渲染的是 `ShortsPoster` 封面占位）：一个
 * 竖屏舞台就是一个播放器实例加三条本机代理会话，为了滑动跟手而多起两份是把
 * 上游取流成本乘三，而滑动过程中相邻条目只需要有画面占位。
 *
 * 播放与弹幕状态由页面持有（见 `ShortsPage`）：顶部与底部操作栏必须固定在视口上、
 * 不能随条带平移，而它们要读 `muted` / `currentTime` —— 状态因此只能住在两者
 * 共同的祖先里。这一层是纯展示。
 */

type ShortsStageProps = {
  item: VideoItem;
  playback: ShortsPlaybackState;
  videoRef: RefObject<HTMLVideoElement | null>;
  danmaku: ShortsDanmakuState;
  /** 弹幕开关。关掉时不挂层。 */
  danmakuVisible: boolean;
  /** 画面信息覆层（UP 主、标题、播放量）开关。 */
  infoVisible: boolean;
  /** 手势进行中：此时禁掉点按，避免滑动尾声的合成 click 误暂停。 */
  gestureActive: boolean;
  onOpenComments: () => void;
};

export function ShortsStage({
  item,
  playback,
  videoRef,
  danmaku,
  danmakuVisible,
  infoVisible,
  gestureActive,
  onOpenComments,
}: ShortsStageProps) {
  const cid = item.cid ?? 0;
  const togglePlay = playback.togglePlay;
  const { size: area, measure } = useShortsStageSize();
  // 起播后以媒体自报画幅为准，起播前用列表下发的 dimension 定框。
  const aspect = shortsMediaAspect(item.dimension, playback.intrinsicSize);
  const frame = shortsMediaFrame(area.width, area.height, aspect);
  const inset = shortsFrameInset(frame, area);

  const cover = normalizeImageUrl(item.cover);
  const face = normalizeImageUrl(item.author_face);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {/*
        背景：封面模糊放大铺满整个面板，填掉画面框之外的区域。

        画面框小于可用区域时（桌面上的居中竖卡、横屏源的上下留边、以及底部操作栏
        与画面之间的空隙）这层可见。恒定渲染而不按画幅分支：「画面框是否小于
        可用区域」取决于视口比例，同一条视频在手机与桌面上的答案不同。
      */}
      {cover && (
        <img
          src={cover}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-2xl saturate-150"
        />
      )}
      {/*
        画面区域内的画面框顶对齐而不是居中。

        竖屏源在手机上比视口略矮（9:16 放进 9:19.5），居中会在画面上方留一条黑边，
        而上方正是系统状态栏之下最该被画面占满的位置。顶对齐把这段空隙全部让给
        下方 —— 那里本来就要放操作栏。
      */}
      <div
        ref={measure}
        data-slot="shorts-media-area"
        className="absolute inset-x-0 flex items-start justify-center"
        style={SHORTS_MEDIA_AREA_STYLE}
      >
        <div
          data-slot="shorts-frame"
          className={cn("relative shrink-0", inset && "overflow-hidden rounded-xl")}
          style={
            {
              ...shortsFrameStyle(frame),
              // 弹幕从顶部控制栏下方开始飘，不从画面顶边开始：画面框的顶边就是
              // 安全区下沿，而控制栏正好压在那一段上，不让位会让弹幕穿过返回按钮。
              "--video-danmaku-top": `${SHORTS_DANMAKU_TOP_OFFSET_PX}px`,
            } as React.CSSProperties
          }
        >
          {/* 封面占位：与画面框同比例，盖到播放器真的出画为止。 */}
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
            // 画面框已经是源画幅的比例，`contain` 在这里只是保险：媒体自报画幅与列表
            // 下发的 dimension 不一致时，宁可留一圈黑边也不裁掉画面。
            className={cn(
              "absolute inset-0 size-full object-contain",
              // 出画前保持透明，让封面负责首帧观感；否则会闪一下黑底。
              playback.loading && "opacity-0",
            )}
          />
          {danmakuVisible && (
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

          {/* 底部渐变：白色文案压在任意画面上都要能读。 */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/75 to-transparent"
          />

          {(playback.loading || playback.waiting) && !playback.error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Spinner className="size-8 text-white/90" aria-label="正在加载" />
            </div>
          )}
          {playback.error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-8 text-center">
              <p className="text-sm text-white/90">{playback.error}</p>
              <Button variant="outline" size="sm" onClick={playback.retry}>
                重试
              </Button>
            </div>
          )}
          {/* 暂停图标：只在用户暂停时出现，加载中的转圈另有指示。 */}
          {playback.paused && !playback.loading && !playback.error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex size-16 items-center justify-center rounded-full bg-black/40">
                <Play className="size-8 text-white/90" aria-hidden />
              </span>
            </div>
          )}

          {/* 右侧操作栏：UP 主头像 + 评论。播放/静音已移到顶部菜单与点按。 */}
          <div className="absolute right-2.5 bottom-20 z-10 flex flex-col items-center gap-4">
            <span className="size-11 overflow-hidden rounded-full border border-white/40 bg-black/30">
              {face ? (
                <img src={face} alt="" aria-hidden className="size-full object-cover" />
              ) : null}
            </span>
            <span className="flex flex-col items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={
                  item.danmaku > 0 ? `评论与弹幕，弹幕 ${formatOnline(item.danmaku)} 条` : "评论"
                }
                title="评论"
                // 竖屏舞台不在播放器皮肤内，`--media-*` 令牌会落到应用前景色，
                // 黑画面上的图标必须自带白字与白色悬停底。
                className="size-11 text-white/90 hover:bg-white/15 hover:text-white"
                onClick={onOpenComments}
              >
                <MessageSquare className="size-6" aria-hidden />
              </Button>
              {item.danmaku > 0 && (
                <span className="text-[11px] text-white/80">{formatOnline(item.danmaku)}</span>
              )}
            </span>
          </div>

          {/* 信息覆层：UP 主、标题、播放量与时长。可由底部「详情开关」收起。 */}
          {infoVisible && (
            <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1.5 px-4 pb-5 pr-16">
              <p className="text-sm font-medium text-white">@{item.author || "未知 UP 主"}</p>
              <p className="line-clamp-2 text-sm text-white/90">{item.title}</p>
              <p className="text-xs text-white/70">
                {formatOnline(item.view)} 次播放
                {playback.duration > 0 || item.duration > 0
                  ? ` · ${formatVideoDuration(playback.duration || item.duration)}`
                  : ""}
              </p>
            </div>
          )}

          <ShortsSeekBar
            currentTime={playback.currentTime}
            duration={playback.duration || item.duration}
            onSeek={playback.seek}
          />

          {/*
            点按暂停/播放的命中层：铺满画面框，位于操作栏与进度条之下（z 更低）。

            只铺画面框而不是整个面板：画面之外是背景区与操作栏，点它们不该改变
            播放状态（与 YouTube Shorts 的桌面形态一致）。

            刻意是 div 而不是 button：铺满画面的按钮会进 Tab 序并被读屏当作一个
            巨大的控件，而它只是指针便利。键盘路径由 Space / K 承担（见 `ShortsPage`）。
          */}
          {/* oxlint-disable-next-line click-events-have-key-events, no-static-element-interactions */}
          <div
            aria-hidden
            // 手势进行中不响应：Android WebView 在识别出的滑动之后仍可能补发 click。
            onClick={gestureActive ? undefined : togglePlay}
            className="absolute inset-0"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 可拖动的进度条。
 *
 * 命中区域比视觉粗细大得多（视觉 3px，命中 20px）：竖屏舞台上这是唯一的横向
 * 精细操作，3px 的目标在触摸下不可用。刻意只在这条带子内认领指针 —— 页面的换片
 * 手势按 `data-slot="shorts-seek"` 跳过从这里开始的按压（见 `ShortsPage`），
 * 因此拖进度不会被误判成换片，画面其余部分也仍然是「点按暂停」。
 *
 * 拖动期间只移动视觉位置，**不**逐帧 seek：每次 seek 都会让 DASH 播放器丢弃缓冲
 * 并向本机代理重新发段请求，跟着手指发几十次等于把取流打崩。松手时落一次。
 */
function ShortsSeekBar({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<number | null>(null);
  /** 拖动中的位置比例；null = 没在拖，跟随播放进度。 */
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  const seekable = duration > 0;
  const playedRatio = seekable ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const ratio = dragRatio ?? playedRatio;

  const ratioFromEvent = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return shortsSeekRatio(event.clientX, rect.left, rect.width);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!seekable || !event.isPrimary) return;
      pointerRef.current = event.pointerId;
      setDragRatio(ratioFromEvent(event));
      // 别让这次按压继续冒泡成换片手势或点按暂停。
      event.stopPropagation();
      /*
       * 指针捕获放在最后且允许失败。
       *
       * 它只是让手指滑出这条带子后事件仍然回到这里（`touch-action: none` 加上
       * 本元素上的 pointermove 已经足够处理带内拖动），因此是增强而不是前提。
       * 而 `setPointerCapture` 会抛 NotFoundError —— 指针已被释放、或元素刚被
       * 重新渲染时都可能。放在前面一旦抛出，后面的 `stopPropagation()` 就不会
       * 执行，这次按压会漏给页面的换片手势：拖进度变成换片，正是要避免的。
       */
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 没有捕获也能拖，只是手指滑出带子后不再跟随。
      }
    },
    [ratioFromEvent, seekable],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (pointerRef.current !== event.pointerId) return;
      setDragRatio(ratioFromEvent(event));
      event.stopPropagation();
    },
    [ratioFromEvent],
  );

  const finish = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
      if (pointerRef.current !== event.pointerId) return;
      pointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const target = commit ? shortsSeekTime(ratioFromEvent(event), duration) : null;
      setDragRatio(null);
      if (target !== null) onSeek(target);
      event.stopPropagation();
    },
    [duration, onSeek, ratioFromEvent],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!seekable) return;
      const step =
        event.key === "ArrowRight"
          ? SHORTS_SEEK_KEY_STEP_SECONDS
          : event.key === "ArrowLeft"
            ? -SHORTS_SEEK_KEY_STEP_SECONDS
            : 0;
      if (step === 0) return;
      // 换片走上下方向键，左右在这里被认领，两者不冲突。
      event.preventDefault();
      event.stopPropagation();
      onSeek(currentTime + step);
    },
    [currentTime, onSeek, seekable],
  );

  return (
    /* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */
    <div
      ref={trackRef}
      data-slot="shorts-seek"
      role="slider"
      tabIndex={seekable ? 0 : -1}
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(ratio * duration)}
      aria-valuetext={`${formatVideoDuration(ratio * duration)} / ${formatVideoDuration(duration)}`}
      aria-disabled={seekable ? undefined : true}
      // 命中区比视觉粗细大得多；`touch-action: none` 让浏览器把纵向移动也交给我们，
      // 否则在这条带子上拖动会被当成页面滚动。
      className="absolute inset-x-0 bottom-0 z-20 flex h-5 cursor-pointer items-end pb-1 touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onKeyDown={onKeyDown}
      // 点按层在下面，别让这里的点击穿下去把播放状态一起切了。
      onClick={(event) => event.stopPropagation()}
    >
      <div className="relative h-[3px] w-full bg-white/25">
        <div
          className="absolute inset-y-0 left-0 bg-white/85"
          style={{ width: `${ratio * 100}%` }}
        />
        {/* 拖动手柄只在拖动时出现：静止时这里是一条细线，不该有额外装饰。 */}
        {dragRatio !== null && (
          <span
            aria-hidden
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
            style={{ left: `${ratio * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 相邻条目的封面占位。
 *
 * 滑动时手指下方必须有真实内容 —— 那正是「跟手」的观感来源 —— 但相邻条目不该
 * 起播。画面框用与活动舞台完全相同的几何（同一块可用区域、同一个
 * `shortsMediaFrame`、同样顶对齐），因此换片时构图不发生跳变：封面停在哪个矩形里，
 * 视频就在那个矩形里出画。
 */
export function ShortsPoster({ item }: { item: VideoItem }) {
  const cover = normalizeImageUrl(item.cover);
  const { size: area, measure } = useShortsStageSize();
  // 占位阶段没有媒体自报画幅，只有列表下发的 dimension。
  const frame = shortsMediaFrame(area.width, area.height, shortsMediaAspect(item.dimension));
  const inset = shortsFrameInset(frame, area);
  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {cover && (
        <img
          src={cover}
          alt=""
          aria-hidden
          className="absolute inset-0 size-full scale-110 object-cover blur-2xl saturate-150"
        />
      )}
      <div
        ref={measure}
        className="absolute inset-x-0 flex items-start justify-center"
        style={SHORTS_MEDIA_AREA_STYLE}
      >
        <div
          className={cn("relative shrink-0", inset && "overflow-hidden rounded-xl")}
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
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/75 to-transparent"
          />
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 px-4 pb-5 pr-16">
            <p className="text-sm font-medium text-white">@{item.author || "未知 UP 主"}</p>
            <p className="line-clamp-2 text-sm text-white/90">{item.title}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

import { MessageSquare, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VideoDanmakuLayer } from "@/features/video/VideoDanmakuLayer";
import { formatVideoDuration } from "@/features/video/videoHistory";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import type { VideoItem } from "@/shared/types/video";
import { shortsMediaAspect, shortsMediaFrame } from "./shortsFeed";
import { useShortsDanmaku } from "./useShortsDanmaku";
import { useShortsPlayback } from "./useShortsPlayback";

/**
 * 舞台自身的像素尺寸。
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
 * 画面框的定位样式：等比内切出的尺寸，居中放在舞台里。
 *
 * 尺寸还没量到时退回铺满，避免首帧出现 0×0 的空框。
 */
function shortsFrameStyle(frame: { width: number; height: number }) {
  return frame.width > 0 && frame.height > 0
    ? { width: `${frame.width}px`, height: `${frame.height}px` }
    : { width: "100%", height: "100%" };
}

/** 画面框是否小于舞台（桌面上的居中卡片形态）：只有这时才给圆角。 */
function shortsFrameInset(
  frame: { width: number; height: number },
  stage: { width: number; height: number },
): boolean {
  if (!(frame.width > 0) || !(stage.width > 0)) return false;
  return frame.width < stage.width - 1 || frame.height < stage.height - 1;
}

/**
 * 竖屏舞台：一条短视频的画面、弹幕层与信息覆层。
 *
 * 只有活动条目会挂载这个组件（相邻条目渲染的是 `ShortsPoster` 封面占位）：一个
 * 竖屏舞台就是一个播放器实例加三条本机代理会话，为了滑动跟手而多起两份是把
 * 上游取流成本乘三，而滑动过程中相邻条目只需要有画面占位。
 */

type ShortsStageProps = {
  item: VideoItem;
  /** 弹幕开关。关掉时不请求分段也不挂层。 */
  danmakuVisible: boolean;
  /** 手势进行中：此时禁掉点按，避免滑动尾声的合成 click 误暂停。 */
  gestureActive: boolean;
  onOpenComments: () => void;
};

export function ShortsStage({
  item,
  danmakuVisible,
  gestureActive,
  onOpenComments,
}: ShortsStageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cid = item.cid ?? 0;
  const danmaku = useShortsDanmaku(cid, danmakuVisible);
  const playback = useShortsPlayback({
    item,
    videoRef,
    active: true,
    onProgress: danmaku.ensure,
  });
  const togglePlay = playback.togglePlay;
  const { size: stage, measure } = useShortsStageSize();
  // 起播后以媒体自报画幅为准，起播前用列表下发的 dimension 定框。
  const aspect = shortsMediaAspect(item.dimension, playback.intrinsicSize);
  const frame = shortsMediaFrame(stage.width, stage.height, aspect);
  const inset = shortsFrameInset(frame, stage);

  /**
   * 空格 / K 播放暂停。
   *
   * 挂在活动舞台上而不是页面上：播放状态只存在于这一层（页面只知道下标），
   * 而只有活动条目会挂载本组件，因此天然不会有第二个监听者抢同一次按键。
   * 上下换片的方向键仍归页面 —— 那是条带的语义。
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key !== " " && event.key !== "k" && event.key !== "K") return;
      const target = event.target;
      // 输入态、按钮与浮层不劫持空格：空格是它们自己的「激活」或滚动。
      // 评论抽屉是滚动容器，打开时空格必须留给它翻页。
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, button, [contenteditable="true"], [data-slot="drawer-content"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      togglePlay();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay]);

  const cover = normalizeImageUrl(item.cover);
  const face = normalizeImageUrl(item.author_face);
  const progress =
    playback.duration > 0 ? Math.min(1, playback.currentTime / playback.duration) : 0;

  return (
    <div
      ref={measure}
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black"
    >
      {/*
        背景：封面模糊放大铺满舞台，填掉画面框之外的区域。

        画面框小于舞台时（桌面上的居中竖卡、手机上横屏源的上下留边）这层可见，
        画面框正好铺满时它被完全盖住。恒定渲染而不按画幅分支：「画面框是否小于
        舞台」取决于视口比例，同一条视频在手机与桌面上的答案不同。
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
        画面框：按源画幅等比内切出的矩形，画面与所有覆层都住在里面。

        覆层跟着画面框而不是舞台 —— 否则桌面上文案与操作栏会贴在离画面很远的视口
        边缘，弹幕也会飘过画面之外的背景区。
      */}
      <div
        data-slot="shorts-frame"
        className={cn("relative shrink-0", inset && "overflow-hidden rounded-xl")}
        style={shortsFrameStyle(frame)}
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

        {/* 上下渐变：白色文案压在任意画面上都要能读。 */}
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

        {/* 右侧操作栏。UP 主头像 + 评论 + 静音。 */}
        <div className="absolute right-2.5 bottom-28 z-10 flex flex-col items-center gap-4">
          <div className="flex flex-col items-center gap-1">
            <span className="size-11 overflow-hidden rounded-full border border-white/40 bg-black/30">
              {face ? (
                <img src={face} alt="" aria-hidden className="size-full object-cover" />
              ) : null}
            </span>
          </div>
          <ShortsActionButton
            label={item.danmaku > 0 ? `评论与弹幕，弹幕 ${formatOnline(item.danmaku)} 条` : "评论"}
            count={item.danmaku}
            onClick={onOpenComments}
          >
            <MessageSquare className="size-6" aria-hidden />
          </ShortsActionButton>
          <ShortsActionButton
            label={playback.muted ? "取消静音" : "静音"}
            onClick={playback.toggleMuted}
          >
            {playback.muted ? (
              <VolumeX className="size-6" aria-hidden />
            ) : (
              <Volume2 className="size-6" aria-hidden />
            )}
          </ShortsActionButton>
          <ShortsActionButton
            label={playback.paused ? "播放" : "暂停"}
            onClick={playback.togglePlay}
          >
            {playback.paused ? (
              <Play className="size-6" aria-hidden />
            ) : (
              <Pause className="size-6" aria-hidden />
            )}
          </ShortsActionButton>
        </div>

        {/* 信息覆层：UP 主、标题、播放量与时长。 */}
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1.5 px-4 pb-6 pr-16">
          <p className="text-sm font-medium text-white">@{item.author || "未知 UP 主"}</p>
          <p className="line-clamp-2 text-sm text-white/90">{item.title}</p>
          <p className="text-xs text-white/70">
            {formatOnline(item.view)} 次播放
            {playback.duration > 0 || item.duration > 0
              ? ` · ${formatVideoDuration(playback.duration || item.duration)}`
              : ""}
          </p>
        </div>

        {/* 进度条：不可拖动。竖屏的横向轴留给系统返回手势，拖动进度请去播放页。 */}
        <div aria-hidden className="absolute inset-x-0 bottom-0 z-10 h-0.5 bg-white/20">
          <div
            className="h-full bg-white/80"
            style={{ transform: `scaleX(${progress})`, transformOrigin: "left" }}
          />
        </div>

        {/*
        点按暂停/播放的命中层：铺满画面框，位于操作栏之下（z 更低）。

        只铺画面框而不是整个舞台：桌面上画面之外是背景区，点它不该改变播放状态
        （与 YouTube Shorts 的桌面形态一致）。手机上画面框几乎等于舞台，无区别。

        刻意是 div 而不是 button：可及性语义归右侧操作栏那颗播放/暂停按钮
        （与 `PlayerControls` 对播放页舞台的关系相同）。铺满整屏的按钮会与它
        同名，读屏里出现两个「暂停」，而这一层只是指针便利。键盘路径由操作栏
        按钮与 Space / K 承担。
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
  );
}

function ShortsActionButton({
  label,
  count,
  onClick,
  children,
}: {
  label: string;
  count?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <span className="flex flex-col items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
        // 竖屏舞台不在播放器皮肤内，`--media-*` 令牌会落到应用前景色，
        // 黑画面上的图标必须自带白字与白色悬停底。
        className="size-11 text-white/90 hover:bg-white/15 hover:text-white"
        onClick={onClick}
      >
        {children}
      </Button>
      {count !== undefined && count > 0 && (
        <span className="text-[11px] text-white/80">{formatOnline(count)}</span>
      )}
    </span>
  );
}

/**
 * 相邻条目的封面占位。
 *
 * 滑动时手指下方必须有真实内容 —— 那正是「跟手」的观感来源 —— 但相邻条目不该
 * 起播。画面框用与活动舞台完全相同的几何（同一个 `shortsMediaFrame`），因此换片
 * 时构图不发生跳变：封面停在哪个矩形里，视频就在那个矩形里出画。
 */
export function ShortsPoster({ item }: { item: VideoItem }) {
  const cover = normalizeImageUrl(item.cover);
  const { size: stage, measure } = useShortsStageSize();
  // 占位阶段没有媒体自报画幅，只有列表下发的 dimension。
  const frame = shortsMediaFrame(stage.width, stage.height, shortsMediaAspect(item.dimension));
  const inset = shortsFrameInset(frame, stage);
  return (
    <div
      ref={measure}
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black"
    >
      {cover && (
        <img
          src={cover}
          alt=""
          aria-hidden
          className="absolute inset-0 size-full scale-110 object-cover blur-2xl saturate-150"
        />
      )}
      <div
        className={cn("relative shrink-0", inset && "overflow-hidden rounded-xl")}
        style={shortsFrameStyle(frame)}
      >
        {cover && (
          <img src={cover} alt="" aria-hidden className="absolute inset-0 size-full object-cover" />
        )}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/75 to-transparent"
        />
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 px-4 pb-6 pr-16">
          <p className="text-sm font-medium text-white">@{item.author || "未知 UP 主"}</p>
          <p className="line-clamp-2 text-sm text-white/90">{item.title}</p>
        </div>
      </div>
    </div>
  );
}

/** 供页面复用的评论抽屉开关状态（把 aid 的空值判断收在一处）。 */
export function useShortsComments(item: VideoItem | null) {
  const [open, setOpen] = useState(false);
  const aid = item?.aid ?? "";
  // 换片时关掉：抽屉里的评论属于上一条。
  const [settledAid, setSettledAid] = useState(aid);
  if (settledAid !== aid) {
    setSettledAid(aid);
    setOpen(false);
  }
  const openComments = useCallback(() => {
    if (aid) setOpen(true);
  }, [aid]);
  return useMemo(() => ({ open, aid, openComments, setOpen }), [aid, open, openComments]);
}

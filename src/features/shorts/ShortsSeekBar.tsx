import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { formatVideoDuration } from "@/features/video/videoHistory";
import {
  SHORTS_SEEK_BAR_HEIGHT_PX,
  SHORTS_SEEK_BAR_HIT_HEIGHT_PX,
  SHORTS_SEEK_KEY_STEP_SECONDS,
  SHORTS_SEEK_PREVIEW_WIDTH_PX,
  shortsSeekPreviewLeft,
  shortsSeekRatio,
  shortsSeekTime,
} from "./shortsFeed";
import { shortsStoryboardTile, useArmedOnce, useShortsStoryboard } from "./shortsStoryboard";

/**
 * 可拖动的进度条：底部操作栏的上边缘。
 *
 * 住在页面的固定层里而不是画面框内：画面会随换片手势整条平移，而进度条属于「当前
 * 这一条的控制」，跟着画面滑走等于在换片过程中把控制层也拖走。贴在操作栏顶边同时
 * 省掉了一条 `border-t` —— 那条线本来就是画面与操作栏的分界。
 *
 * 命中区域比视觉粗细大得多（视觉 3px，命中 20px）并且只向**上**撑开：竖屏舞台上这是
 * 唯一的横向精细操作，3px 的目标在触摸下不可用；而向下撑开会盖住弹幕输入框。
 * 只有视觉的 3px 占布局空间，命中区是绝对定位的浮层，因此画面与进度条之间不会
 * 凭空多出一条边距。
 *
 * 刻意只在这条带子内认领指针 —— 页面的换片手势按 `data-slot="shorts-seek"` 跳过从
 * 这里开始的按压（见 `ShortsPage`），因此拖进度不会被误判成换片。
 *
 * 拖动期间只移动视觉位置，**不**逐帧 seek：每次 seek 都会让 DASH 播放器丢弃缓冲
 * 并向本机代理重新发段请求，跟着手指发几十次等于把取流打崩。松手时落一次。
 * 拖动中的反馈因此全靠时间气泡与缩略图，而不是画面本身。
 */
export function ShortsSeekBar({
  bvid,
  cid,
  currentTime,
  duration,
  onSeek,
}: {
  bvid: string;
  cid: number;
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<number | null>(null);
  /** 拖动中的位置比例；null = 没在拖，跟随播放进度。 */
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  /**
   * 轨道宽度，按下时量一次。
   *
   * 只有预览气泡的夹取需要它。不在渲染期读 `trackRef.current.clientWidth`：渲染期读
   * ref 不是纯函数，首帧还读不到值。按下时本来就要 `getBoundingClientRect()`，
   * 顺手把宽度记下来是零成本。
   */
  const [trackWidth, setTrackWidth] = useState(0);
  /** 缩略图快照只在用户真的动过进度条之后才取（见 `useArmedOnce`）。 */
  const dragging = dragRatio !== null;
  const storyboardArmed = useArmedOnce(dragging);
  const { storyboard, sheetUrls } = useShortsStoryboard({ bvid, cid, enabled: storyboardArmed });

  const seekable = duration > 0;
  const playedRatio = seekable ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const ratio = dragRatio ?? playedRatio;
  const previewTime = ratio * duration;
  const tile = dragging ? shortsStoryboardTile(storyboard, previewTime, sheetUrls) : null;

  const ratioFromEvent = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return shortsSeekRatio(event.clientX, rect.left, rect.width);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!seekable || !event.isPrimary) return;
      pointerRef.current = event.pointerId;
      setTrackWidth(trackRef.current?.getBoundingClientRect().width ?? 0);
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
    // 外层只占视觉那 3px 的布局空间；命中区与预览气泡都是它的绝对定位子元素，
    // 向上盖到画面上而不推开任何东西。
    <div className="relative shrink-0" style={{ height: `${SHORTS_SEEK_BAR_HEIGHT_PX}px` }}>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        data-slot="shorts-seek"
        role="slider"
        tabIndex={seekable ? 0 : -1}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(ratio * duration)}
        aria-valuetext={`${formatVideoDuration(ratio * duration)} / ${formatVideoDuration(duration)}`}
        aria-disabled={seekable ? undefined : true}
        // `touch-action: none` 让浏览器把纵向移动也交给我们，否则在这条带子上拖动
        // 会被当成页面滚动。
        className="absolute inset-x-0 bottom-0 flex cursor-pointer items-end touch-none"
        style={{ height: `${SHORTS_SEEK_BAR_HIT_HEIGHT_PX}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
        onKeyDown={onKeyDown}
        // 点按层在画面上，别让这里的点击穿下去把播放状态一起切了。
        onClick={(event) => event.stopPropagation()}
      >
        <div
          ref={trackRef}
          className="relative w-full bg-white/25"
          style={{ height: `${SHORTS_SEEK_BAR_HEIGHT_PX}px` }}
        >
          <div
            className="absolute inset-y-0 left-0 bg-white/85"
            style={{ width: `${ratio * 100}%` }}
          />
          {/* 拖动手柄只在拖动时出现：静止时这里是一条细线，不该有额外装饰。 */}
          {dragging && (
            <span
              aria-hidden
              className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
              style={{ left: `${ratio * 100}%` }}
            />
          )}
          {/*
            拖动预览：时间 + 缩略图。

            因为拖动期间画面不跟随（只在松手时 seek 一次），这个气泡是拖动中唯一的
            位置反馈。水平位置绑手指并在两端夹住（`shortsSeekPreviewLeft`）：否则拖到
            0% 或 100% 时气泡一半会被画面外沿裁掉。

            缩略图可能永远不来（部分稿件无快照，或代理未就绪），因此时间文本不依赖它：
            没图时这里就是一个紧凑的时间气泡。
          */}
          {dragging && (
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-3 flex flex-col items-center gap-1"
              style={{
                left: `${shortsSeekPreviewLeft(ratio, trackWidth, SHORTS_SEEK_PREVIEW_WIDTH_PX)}px`,
                width: `${SHORTS_SEEK_PREVIEW_WIDTH_PX}px`,
              }}
            >
              {tile && (
                <span
                  className="block overflow-hidden rounded-sm border border-white/30 bg-black/60 shadow-lg"
                  style={{
                    width: `${SHORTS_SEEK_PREVIEW_WIDTH_PX}px`,
                    height: `${Math.round((SHORTS_SEEK_PREVIEW_WIDTH_PX / tile.width) * tile.height)}px`,
                    backgroundImage: `url("${tile.url}")`,
                    // 雪碧图整张按预览宽度缩放，再按同一倍率偏移到目标小图。
                    backgroundSize: `${tile.sheetWidth * (SHORTS_SEEK_PREVIEW_WIDTH_PX / tile.width)}px ${
                      tile.sheetHeight * (SHORTS_SEEK_PREVIEW_WIDTH_PX / tile.width)
                    }px`,
                    backgroundPosition: `-${tile.x * (SHORTS_SEEK_PREVIEW_WIDTH_PX / tile.width)}px -${
                      tile.y * (SHORTS_SEEK_PREVIEW_WIDTH_PX / tile.width)
                    }px`,
                    backgroundRepeat: "no-repeat",
                  }}
                />
              )}
              <span className="rounded bg-black/75 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
                {formatVideoDuration(previewTime)} / {formatVideoDuration(duration)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

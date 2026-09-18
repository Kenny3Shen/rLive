import type { ThumbnailImage } from "@videojs/core";
import { ShortsTimeSlider } from "@/components/videojs/ui/shorts-time-slider";
import {
  SHORTS_SEEK_BAR_HEIGHT_PX,
  SHORTS_SEEK_BAR_HIT_HEIGHT_PX,
  SHORTS_SEEK_KEY_STEP_SECONDS,
} from "./shortsFeed";

/**
 * 可拖动的进度条：底部操作栏的上边缘。
 *
 * 真正的时间轴交互交给 Video.js 原语 `TimeSlider`（细变体见 `ShortsTimeSlider`）：
 * 拖动、点击、键盘、缓冲区间、悬停/拖动预览与缩略图都由它承担。这一层只做三件事：
 *
 * 1. **分层布局**：外层只占视觉那 3px 的布局空间，原语根节点作为 20px 命中层绝对定位在
 *    它底边上、只向**上**撑开。竖屏舞台上这是唯一的横向精细操作，3px 的目标在触摸下
 *    不可用；而向下撑开会盖住底栏里的弹幕输入框（实测命中区底边与输入框顶边刚好不
 *    重叠）。只有视觉的 3px 占布局空间，因此画面与进度条之间不会凭空多出一条边距。
 * 2. **认领标记**：`data-slot="shorts-seek"` 必须标在 20px 命中层上。页面的换片手势
 *    按它跳过从这里开始的按压（见 `ShortsPage`），←/→ 也因此交给进度条而不是换片。
 * 3. **首次交互回调**：`onArmed` 让页面在用户真的碰进度条时才去取快照雪碧图。
 *
 * 拖动期间**不**逐帧 seek 的行为原来由自绘实现保证，现在由原语的 `changeThrottle`
 * （默认 100ms）与「释放才 commit」共同保证 —— 每次 seek 都会让 DASH 播放器丢弃缓冲
 * 并向本机代理重新发段请求，跟着手指发几十次等于把取流打崩。
 */
export function ShortsSeekBar({
  thumbnails,
  onArmed,
}: {
  /** 快照雪碧图铺出的缩略图整表；空数组时只显示时间气泡。 */
  thumbnails: ThumbnailImage[];
  /** 用户第一次悬停/按下进度条时调用一次。 */
  onArmed: () => void;
}) {
  return (
    // 外层只占视觉那 3px 的布局空间；命中层是它的绝对定位子元素，向上盖到画面上而不
    // 推开任何东西。
    <div className="relative shrink-0" style={{ height: `${SHORTS_SEEK_BAR_HEIGHT_PX}px` }}>
      <ShortsTimeSlider
        data-slot="shorts-seek"
        label="播放进度"
        // 左右方向键走 5 秒，与播放页同一口径；上下方向键由页面在捕获阶段抢回换片。
        step={SHORTS_SEEK_KEY_STEP_SECONDS}
        thumbnails={thumbnails}
        // 悬停（桌面预览）与按下（触摸）都算「开始交互」。放在捕获阶段：原语自己的
        // pointerdown 会 stopPropagation，冒泡到不了这里。
        onPointerEnter={onArmed}
        onPointerDownCapture={onArmed}
        className="absolute inset-x-0 bottom-0"
        style={{ height: `${SHORTS_SEEK_BAR_HIT_HEIGHT_PX}px` }}
      />
    </div>
  );
}

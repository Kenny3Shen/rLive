import { memo } from "react";
import { Ban, Copy, MessageSquarePlus, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { glassOptionClass, glassPanelClass } from "@/shared/components/player/glassSurface";
import type { DanmakuEvent, SiteId } from "@/shared/types/live";
import { useDanmakuActions } from "../danmaku/useDanmakuActions";
import { cn } from "@/lib/utils";

/**
 * 直播视频舞台上指针所指的评论。渲染器移交元素相对的 CSS 盒（含边框内边距），
 * 菜单锚定到它上面。
 */
export type DanmakuHoverTarget = {
  hoverKey: string;
  /** 原始评论正文，不含聚合后缀。 */
  content: string;
  user: string;
  eventKind: DanmakuEvent["kind"];
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * 胶囊在其锚点两侧需要的横向空间，供把它保持在屏内的 CSS `clamp` 使用。
 *
 * 数值贴近真实半宽：一旦锚点距离边缘不足此值，`clamp` 就停止居中，
 * 夸大的取值会让胶囊明显脱离其所属评论。紧凑版是四个 36px 按钮加 6px 间距
 * 和内边距（约 92px）；大号版是四个 44px 按钮加 8px 间距和内边距
 * （约 112px）。
 */
const MENU_HALF_WIDTH_PX = 92;
const MENU_HALF_WIDTH_LARGE_PX = 112;
/**
 * 给菜单打上标记，使舞台渲染器能把落在菜单上的按压与落在别处的按压区分开 ——
 * 后者会取消钉住的评论。在这里声明、也在这里应用该属性，
 * 使指针委托以与组件相同的方向导入它。
 */
export const DANMAKU_MENU_ATTR = "data-danmaku-menu";
/**
 * 评论与胶囊之间的视觉距离。
 *
 * 用透明内边距而不是定位偏移实现，让间隙留在元素内部：
 * 稍微没点到按钮的按压仍算按在菜单上，
 * 不会取消钉住。
 */
const MENU_GAP_PX = 6;
/** 低于此值胶囊会裁掉顶边，因此翻转到评论下方。 */
const MENU_FLIP_THRESHOLD_PX = 56;

type DanmakuActionMenuProps = {
  target: DanmakuHoverTarget;
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  /** 为全屏桌面舞台提供的更大瞄准目标。 */
  large?: boolean;
};

export const DanmakuActionMenu = memo(function DanmakuActionMenu({
  target,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  large = false,
}: DanmakuActionMenuProps) {
  const message = target.content.trim();
  const actions = useDanmakuActions({
    message,
    eventKind: target.eventKind,
    user: target.user,
    siteId,
    roomId,
    roomTitle,
    roomUserName,
  });
  const flipBelow = target.top < MENU_FLIP_THRESHOLD_PX;
  const anchorX = target.left + target.width / 2;
  const halfWidth = large ? MENU_HALF_WIDTH_LARGE_PX : MENU_HALF_WIDTH_PX;
  const buttonClass = large
    ? "size-11"
    : // 共享 Button 组件默认提供 44px 粗指针目标。这个
      // 一次性的三按钮胶囊在手机上需要常规 36px 图标按钮密度，
      // 避免遮挡过大的视频区域。
      "[@media(pointer:coarse)]:size-9 [@media(pointer:coarse)]:min-h-9 [@media(pointer:coarse)]:min-w-9";
  const iconClass = large ? "size-6" : "size-5";

  return (
    <div
      // 播放器舞台把裸指针按压当作视频手势。把它标记为 chrome 并吞掉按压，
      // 使对评论的操作不会同时切换播放或全屏。`pointermove` 仍会冒泡，
      // 指针停留期间控制条保持唤醒。
      data-player-hud
      // 让外部按压委托识别本元素，使按菜单绝不构成取消钉住的那次按压。
      {...{ [DANMAKU_MENU_ATTR]: "" }}
      role="group"
      aria-label={`${target.user || "匿名"} 的弹幕操作`}
      className={cn(
        "pointer-events-auto absolute z-10 flex -translate-x-1/2 flex-col items-center",
        // 朝向评论一侧的内边距而非定位偏移：呈现为同样的视觉间隙但保持在元素命中
        // 区域内，指针通往按钮的路上不会穿过死区。
        flipBelow ? "translate-y-0 pt-1.5" : "-translate-y-full pb-1.5",
        large ? "gap-1.5" : "gap-1",
      )}
      style={{
        left: `clamp(${halfWidth}px, ${anchorX}px, calc(100% - ${halfWidth}px))`,
        top: flipBelow ? target.top + target.height : Math.max(0, target.top),
        paddingLeft: MENU_GAP_PX,
        paddingRight: MENU_GAP_PX,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {flipBelow && actions.statusMessage && (
        <DanmakuActionStatus message={actions.statusMessage} failed={actions.failed} />
      )}
      <div
        className={cn(
          // 按钮之间留出间隔而不是贴紧：它们是移动画面上的圆形目标，
          // 误触会发出评论或写入剪贴板，因此间隙是刻意设计而非装饰。
          "flex items-center rounded-full",
          large ? "gap-2 p-2" : "gap-1.5 p-1.5",
          glassPanelClass({ overlay: true }),
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn("rounded-full", buttonClass, glassOptionClass({ overlay: true }))}
          aria-label="复制弹幕"
          title="复制弹幕"
          onClick={() => void actions.copy()}
        >
          <Copy aria-hidden className={iconClass} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn("rounded-full", buttonClass, glassOptionClass({ overlay: true }))}
          disabled={!actions.canFavorite || actions.favoriting}
          aria-label={actions.favoriteLabel}
          title={actions.favoriteLabel}
          onClick={() => void actions.favorite()}
        >
          {actions.favoriting ? (
            <Spinner aria-hidden className={iconClass} />
          ) : (
            <Star aria-hidden className={iconClass} />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn("rounded-full", buttonClass, glassOptionClass({ overlay: true }))}
          disabled={!actions.canRepeat || actions.sending}
          aria-label={actions.repeatLabel}
          title={actions.repeatLabel}
          onClick={() => void actions.repeat()}
        >
          {/* 带加号的气泡读作"再发一条"，正是 +1 的含义。`SendHorizontal` 读作
              "发送我输入的内容" —— 这里没有输入框。方形气泡已是播放器 chrome 中
              弹幕的符号（`MessageSquareText` / `MessageSquareOff`）。 */}
          <MessageSquarePlus aria-hidden className={iconClass} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn(
            "rounded-full text-red-300 hover:text-red-200",
            buttonClass,
            glassOptionClass({ overlay: true }),
          )}
          disabled={!actions.canBlock}
          aria-label={actions.blockLabel}
          title={actions.blockLabel}
          onClick={() => {
            // 屏蔽是即时承诺：宿主的屏蔽副作用会撤下这条评论并随之收起菜单，
            // 因此这里只负责写入偏好本身。
            actions.block();
          }}
        >
          <Ban aria-hidden className={iconClass} />
        </Button>
      </div>
      {!flipBelow && actions.statusMessage && (
        <DanmakuActionStatus message={actions.statusMessage} failed={actions.failed} />
      )}
    </div>
  );
});

function DanmakuActionStatus({ message, failed }: { message: string; failed: boolean }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "max-w-56 rounded-full px-2 py-0.5 text-center text-[11px] leading-snug whitespace-nowrap",
        glassPanelClass({ overlay: true }),
        failed ? "text-red-200" : "text-white/75",
      )}
    >
      {message}
    </p>
  );
}

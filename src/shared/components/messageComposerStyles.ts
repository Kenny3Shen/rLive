import { cn } from "@/lib/utils";

/** 侧栏消息输入区共用的留白；只保留输入框描边，不叠加分隔横线。底色按用途分开，见下。 */
export const MESSAGE_COMPOSER_SURFACE_CLASS = "min-w-0 shrink-0 px-2.5 py-2";

/**
 * 两种发送区的底色。桌面侧栏里评论与弹幕页签相邻、几何完全一致，同一底色下切页签时
 * 读不出「现在发的是评论还是弹幕」。弹幕沿用侧栏底色（直播间侧栏同款），评论取
 * `muted`：亮暗两套主题里都与侧栏、输入框本身拉开一档。
 */
export const COMMENT_COMPOSER_TONE_CLASS = "bg-muted/70";
export const DANMAKU_COMPOSER_TONE_CLASS = "bg-sidebar/80";

/**
 * 评论发送区的底色按客户端分端：移动端两个发送区都贴在播放器下方的同一块侧栏底部，
 * 与页签条、播放器下沿一起构成整块底色，评论单独换色反而像一块补丁，因此与弹幕统一；
 * 桌面保留区分色。`mobile` 由调用方按 `isMobileClient()` 传入，与侧栏横滑同一判据。
 */
export function commentComposerToneClass(mobile: boolean): string {
  return mobile ? DANMAKU_COMPOSER_TONE_CLASS : COMMENT_COMPOSER_TONE_CLASS;
}
export const MESSAGE_COMPOSER_GROUP_CLASS = "h-auto min-h-8 min-w-0";

/** 输入框两端的操作共用尺寸，评论发送与弹幕发送保持一致。 */
export const MESSAGE_COMPOSER_BUTTON_CLASS =
  "size-7 rounded-md transition-colors [@media(pointer:coarse)]:min-w-8";

export function messageComposerSendButtonClass(canSubmit: boolean): string {
  return cn(
    MESSAGE_COMPOSER_BUTTON_CLASS,
    "text-muted-foreground hover:text-foreground disabled:text-muted-foreground/60 disabled:opacity-100",
    canSubmit &&
      "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
  );
}

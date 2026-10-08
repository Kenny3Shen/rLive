import { cn } from "@/lib/utils";

/** 侧栏消息输入区共用的留白；只保留输入框描边，不叠加分隔横线。 */
export const MESSAGE_COMPOSER_SURFACE_CLASS = "min-w-0 shrink-0 bg-sidebar/80 px-2.5 py-2";
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

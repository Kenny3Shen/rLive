/**
 * 直播间之外的视频评论共用无业务样式。
 *
 * Bilibili 与 AcFun 的评论数据、互动能力和分页协议独立，只共享侧栏中的视觉规格，
 * 避免主评论、回复预览和展开回复在平台接入之间漂移。
 */
export const videoCommentStyles = {
  panelHeader: "flex items-center justify-between px-3 pb-2 pt-3",
  panelCount: "text-xs text-muted-foreground",
  sortButton: "h-6 gap-1 px-2 text-xs text-muted-foreground",
  skeletonList: "flex flex-col gap-4 px-3 pb-4",
  skeletonRow: "flex gap-2.5",
  avatar: "mt-0.5 size-8 shrink-0 rounded-full object-cover",
  avatarPlaceholder: "mt-0.5 size-8 shrink-0 rounded-full bg-muted",
  row: "flex gap-2.5 leading-normal",
  metaRow: "flex min-w-0 items-center gap-1.5",
  mainAuthor: "truncate text-[13px] font-medium text-foreground/90",
  previewAuthor: "truncate text-xs font-medium text-foreground/90",
  upBadge:
    "h-auto shrink-0 rounded-sm border-0 bg-accent/18 px-1 py-0 text-[10px] leading-4 font-semibold text-accent",
  inlineUpBadge:
    "mx-0.5 inline-flex h-4 items-center rounded-sm bg-accent/18 px-1 align-middle text-[10px] leading-4 font-semibold whitespace-nowrap text-accent",
  time: "mt-0.5 text-[11px] text-muted-foreground",
  bodyWrap: "mt-1",
  body: "whitespace-pre-line break-words text-[13px] leading-relaxed [overflow-wrap:anywhere]",
  actionRow: "mt-1 -ml-1 flex items-center gap-3",
  actionStat:
    "inline-flex h-5 items-center gap-1 px-1 text-[11px] font-normal text-muted-foreground [&_svg:not([class*='size-'])]:size-3",
  action:
    "h-5 gap-1 px-1 text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground [@media(pointer:coarse)]:min-h-0 [&_svg:not([class*='size-'])]:size-3",
  thread: "border-b border-border/60 py-3 last:border-b-0",
  previewIndent: "mt-2 pl-10.5",
  previewSurface: "overflow-hidden rounded-md bg-muted/40 py-1",
  previewButton:
    "w-full px-2 py-1.5 text-left text-xs leading-relaxed transition-colors hover:bg-muted/70",
  previewText: "line-clamp-2 break-words [overflow-wrap:anywhere]",
  replyRow: "border-b border-border/60 py-3 last:border-b-0",
  replyHeader: "flex items-center justify-between gap-2",
  replyCount: "text-xs text-muted-foreground",
  replyActionButton: "h-6 gap-1 px-2 text-xs text-muted-foreground",
} as const;

/**
 * 网格卡片表面（直播房间卡、视频卡、关注卡）的唯一事实来源。
 *
 * 这些卡片原先各自内联同一串类名，于是关注页与媒体卡片悄悄分了家：底色与悬停
 * 提亮一致，描边却一个是 `border-subtle`、一个是 `Card` 原语默认的 `foreground/10`，
 * 海拔则只有媒体卡片有。四处引用同一个常量，改一处即全部对齐。
 *
 * 只含表面本身，不含几何与过渡：媒体卡片是 `<button>`，过渡由 `[data-motion-press]`
 * 提供；关注卡片是 `Card` 原语加内层绝对定位按钮，需要自己带 `transition-*` 类。
 *
 * 底色与描边全部取自会随主题翻转的 token（`--card`、`--card-elevated`、
 * `--border-subtle`），亮暗两种模式因此自动对齐，不需要 `dark:` 分支。
 * 投影是固定的 `black/30`，与媒体卡片一致。
 */

/** 卡片表面：底色 + 海拔 + 细描边。可叠加在 `Card` 原语上（后者自带的
 * `ring-foreground/10` 会被这里的 `ring-border-subtle` 覆盖）。 */
export const CARD_SURFACE_CLASS = "bg-card shadow-md shadow-black/30 ring-1 ring-border-subtle";

/** 悬停提亮：底色升到 elevated，描边提亮到 `foreground/20`。 */
export const CARD_SURFACE_HOVER_CLASS = "hover:bg-card-elevated hover:ring-foreground/20";

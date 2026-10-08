/**
 * 播放页侧栏三类选集卡片（多 P 选集、UGC 合集、PGC 分集）的默认展开策略。
 *
 * - 移动端一律默认收起：侧栏只占播放器下方那一截，展开的列表（最高 256px）一上来就把
 *   相关视频挤出首屏，而只看当前这一集的场景远多于换集；需要时点标题行展开。
 * - 桌面端：多 P 选集与 PGC 分集展开；合集单独存在时展开，与多 P 并存时收起，
 *   避免两份长列表同时摊开。
 *
 * 只决定挂载时的初值：同稿件换 P、同剧换集保持用户手动的折叠状态，换稿件或剧集时
 * 由面板的 key 重挂后重新取值。
 */
export type VideoSelectionKind = "parts" | "season" | "episodes";

export function videoSelectionDefaultOpen(
  kind: VideoSelectionKind,
  { mobile, multiPart = false }: { mobile: boolean; multiPart?: boolean },
): boolean {
  if (mobile) return false;
  if (kind === "season") return !multiPart;
  return true;
}

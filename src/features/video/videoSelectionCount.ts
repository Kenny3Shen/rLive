/**
 * 选集类卡片标题行右侧的数量文案（「合集」「选集」「分集」三张卡共用）。
 *
 * 播放页侧栏里这三张卡说的是同一件事：**当前播放项在这份列表里的位置**。从前它们
 * 只报总数（「共 12 个」「共 8 P」「共 24 集」），用户读得出「有多少」，读不出「我
 * 在第几个」—— 合集尤其如此：连播换集时标题行看不出进度，得展开列表去找那一条高亮。
 * 因此有当前项时改报 `x/y`（x 为当前项序号、y 为总数），序号从 1 开始。
 *
 * 定位不到当前项时（链接缺 cid 的搜索入口、合集改版后的脏数据、PGC 分集表还没到）
 * 退回原来的「共 N …」：位置是事实，算不出就不编 —— 报 `0/y` 或猜一个序号都会
 * 变成错误信息。
 */

/** 数量文案的单位词，决定「共 N …」那半句怎么读。 */
export type VideoSelectionCountUnit = "个" | "P" | "集";

/**
 * 生成标题行右侧的数量文案。
 *
 * @param index 当前项在列表里的下标；定位不到时传负数或 `undefined`。
 * @param total 列表总长度。
 * @param unit 「共 N …」的单位词（`x/y` 形态用不到它）。
 */
export function videoSelectionCount(
  index: number | undefined,
  total: number,
  unit: VideoSelectionCountUnit,
): string {
  if (index !== undefined && index >= 0 && index < total) return `${index + 1}/${total}`;
  return `共 ${total} ${unit}`;
}

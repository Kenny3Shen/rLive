import type { VideoItem } from "@/shared/types/video";

/**
 * 按 UID 屏蔽的 UP 主名单。
 *
 * 名单以**作者 UID**（列表条目里的 `owner.mid`）为准，而不是昵称：昵称会重名、
 * 会被改，屏蔽结果因此不可预期。条目缺失 UID 时（老缓存、上游未下发、部分列表
 * 形状）**不屏蔽** —— 宁可少屏蔽，不可把别人错屏蔽成同一个昵称的作者。
 *
 * 这是一条纯过滤，不碰网络：被屏蔽的条目在列表渲染前就被摘掉，分页游标与
 * 上游请求次数都不变（见各列表的接线处）。
 */

/** 名单查询用的集合；空名单时返回 `null`，调用方据此跳过整条过滤。 */
export function videoBlockedUploaderSet(
  uploaders: readonly string[],
): ReadonlySet<string> | null {
  const set = new Set<string>();
  for (const raw of uploaders) {
    if (typeof raw !== "string") continue;
    const mid = raw.trim();
    if (mid) set.add(mid);
  }
  return set.size > 0 ? set : null;
}

/** 这条稿件的作者是否在屏蔽名单里。缺失 UID 一律返回 false。 */
export function isBlockedUploader(
  item: Pick<VideoItem, "author_mid">,
  blocked: ReadonlySet<string> | null,
): boolean {
  if (!blocked) return false;
  const mid = item.author_mid?.trim();
  return Boolean(mid && blocked.has(mid));
}

/**
 * 去掉被屏蔽 UP 主的条目。`blocked` 为 `null`（名单为空）时原样返回，
 * 不复制数组 —— 列表每次渲染都会走这里，空名单必须零成本。
 */
export function filterBlockedUploaders<T extends Pick<VideoItem, "author_mid">>(
  items: readonly T[],
  blocked: ReadonlySet<string> | null,
): readonly T[] {
  if (!blocked) return items;
  return items.filter((item) => !isBlockedUploader(item, blocked));
}

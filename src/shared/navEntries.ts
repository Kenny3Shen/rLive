/**
 * 可由用户在「设置 → 外观配置 → 主页入口」中隐藏的导航入口。
 *
 * 存储的是「隐藏项」而不是「可见项」：这样新版本新增的入口默认可见，
 * 旧记录也不会因为多出一个字段而丢掉入口。
 *
 * 只包含导航栏里的内容型目的地。首页、关注、设置是应用的基本骨架，
 * 不参与这项偏好 —— 用户关掉它们会让应用无法导航回来。
 */
export const HOME_ENTRY_IDS = ["video", "shorts", "iptv"] as const;

export type HomeEntryId = (typeof HOME_ENTRY_IDS)[number];

const HOME_ENTRY_ID_SET = new Set<string>(HOME_ENTRY_IDS);

export function isHomeEntryId(value: unknown): value is HomeEntryId {
  return typeof value === "string" && HOME_ENTRY_ID_SET.has(value);
}

/**
 * 净化持久化的隐藏入口列表：丢弃未知 id 与重复项，并按固定顺序返回，
 * 使设置写入结果与输入顺序无关。
 */
export function normalizeHiddenHomeEntryIds(value: unknown): HomeEntryId[] {
  if (!Array.isArray(value)) return [];

  const requested = new Set(value.filter(isHomeEntryId));
  return HOME_ENTRY_IDS.filter((entryId) => requested.has(entryId));
}

/** 切换单个入口的可见性，保持至少一个平台可见那类不变量在这里不适用。 */
export function updateHiddenHomeEntryIds(
  hidden: unknown,
  entryId: HomeEntryId,
  visible: boolean,
): HomeEntryId[] {
  const next = new Set(normalizeHiddenHomeEntryIds(hidden));
  if (visible) next.delete(entryId);
  else next.add(entryId);
  return normalizeHiddenHomeEntryIds([...next]);
}

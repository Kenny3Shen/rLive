/** 上游分页可能重叠；用内容 id 保留首次出现顺序并去掉跨页重复项。 */
export function dedupeAcfunItems<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

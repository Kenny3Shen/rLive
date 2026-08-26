import type { LiveSubCategory } from "@/shared/types/live";

/**
 * 把分类导航保留在真实路由中，选择分类绝不会把它的房间
 * 追加到分类浏览器下面。
 */
export function categoryRoomsPath(category: LiveSubCategory): string {
  const parentId = encodeURIComponent(category.parent_id);
  const categoryId = encodeURIComponent(category.id);
  const query = new URLSearchParams({ name: category.name });
  return `/category/${parentId}/${categoryId}?${query.toString()}`;
}

export function categoryNameFromSearch(value: string | null): string {
  return value?.trim() ?? "";
}

/**
 * 分类 id 属于特定平台。因此分类房间 URL 无法安全地在平台切换后存活：
 * 同一批 id 在新平台上可能解析到无关分类（或不存在）。
 */
export function categoryHomePathAfterSiteChange(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "category" ? "/category" : null;
}

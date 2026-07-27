import type { LiveSubCategory } from "@/shared/types/live";

/**
 * Keep category navigation in a real route so selecting a category never
 * appends its rooms beneath the category browser.
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
 * Category IDs belong to a platform.  A category-room URL therefore cannot
 * safely survive a platform switch: the same IDs may resolve to an unrelated
 * category (or no category) on the newly selected platform.
 */
export function categoryHomePathAfterSiteChange(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "category" ? "/category" : null;
}

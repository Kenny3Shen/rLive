import type { LiveRoomItem } from "@/shared/types/live";

export const SEARCH_SCOPES = [
  { value: "all", label: "全部" },
  { value: "user", label: "主播" },
  { value: "room", label: "房间号" },
  { value: "title", label: "标题" },
] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number]["value"];
export type SearchMatch = Exclude<SearchScope, "all"> | "related";

export function parseSearchScope(value: string | null): SearchScope {
  return SEARCH_SCOPES.some((scope) => scope.value === value) ? (value as SearchScope) : "all";
}

export function searchPath(keyword: string, scope: SearchScope = "all"): string {
  const q = keyword.trim();
  if (!q) return "/search";

  const params = new URLSearchParams({ q });
  if (scope !== "all") params.set("scope", scope);
  return `/search?${params.toString()}`;
}

export function searchScopeLabel(scope: SearchScope): string {
  return SEARCH_SCOPES.find((item) => item.value === scope)?.label ?? "全部";
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function includes(value: string, keyword: string): boolean {
  return normalize(value).includes(keyword);
}

export function searchMatch(room: LiveRoomItem, keyword: string): SearchMatch {
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return "related";

  if (includes(room.room_id, normalizedKeyword)) return "room";
  if (includes(room.user_name, normalizedKeyword)) return "user";
  if (includes(room.title, normalizedKeyword)) return "title";
  return "related";
}

function matchScope(room: LiveRoomItem, keyword: string, scope: SearchScope): boolean {
  if (scope === "all") return true;
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return true;
  if (scope === "room") return includes(room.room_id, normalizedKeyword);
  if (scope === "user") return includes(room.user_name, normalizedKeyword);
  return includes(room.title, normalizedKeyword);
}

function rank(room: LiveRoomItem, keyword: string, scope: SearchScope): number {
  const normalizedKeyword = normalize(keyword);
  const fields: Array<[SearchMatch, string]> = [
    ["room", room.room_id],
    ["user", room.user_name],
    ["title", room.title],
  ];

  const selected = scope === "all" ? fields : fields.filter(([field]) => field === scope);
  for (let index = 0; index < selected.length; index += 1) {
    const [, value] = selected[index];
    const normalizedValue = normalize(value);
    if (normalizedValue === normalizedKeyword) return index * 2;
    if (normalizedValue.startsWith(normalizedKeyword)) return index * 2 + 1;
  }

  return selected.length * 2;
}

/**
 * 站点返回宽泛的搜索响应。这里让用户选择的字段显式生效、去除重复页，
 * 并把精确匹配提前。
 */
export function prepareSearchResults(
  rooms: LiveRoomItem[],
  keyword: string,
  scope: SearchScope,
): LiveRoomItem[] {
  const seen = new Set<string>();
  const filtered = rooms.filter((room) => {
    const id = `${room.site_id}:${room.room_id}`;
    if (seen.has(id) || !matchScope(room, keyword, scope)) return false;
    seen.add(id);
    return true;
  });

  return filtered.sort((left, right) => rank(left, keyword, scope) - rank(right, keyword, scope));
}

export function roomFromDetail(detail: {
  site_id: LiveRoomItem["site_id"];
  room_id: string;
  title: string;
  cover: string;
  user_name: string;
  online: number;
}): LiveRoomItem {
  return {
    site_id: detail.site_id,
    room_id: detail.room_id,
    title: detail.title,
    cover: detail.cover,
    user_name: detail.user_name,
    online: detail.online,
  };
}

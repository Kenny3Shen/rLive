import { canNavigateBackInApp } from "@/shared/appHistory";

export const ACFUN_SOURCE = "acfun";
export const VIDEO_SOURCE_PARAM = "source";
export const ACFUN_VIEW_PARAM = "view";
export const ACFUN_SECTION_PARAM = "section";
export const ACFUN_CHANNEL_PARAM = "channel";
export const ACFUN_SEARCH_QUERY_PARAM = "q";
export const ACFUN_SEARCH_PATH = "/video/acfun/search";
export const ACFUN_PLAY_PATH = "/video/acfun/play";
export const ACFUN_ARTICLE_PATH = "/video/acfun/article";

export const ACFUN_VIEWS = ["video", "article"] as const;
export type AcfunView = (typeof ACFUN_VIEWS)[number];

export const ACFUN_VIEW_LABELS: Record<AcfunView, string> = {
  video: "视频",
  article: "文章",
};

export function isAcfunSource(value: string | null): boolean {
  return value === ACFUN_SOURCE;
}

export function acfunContentId(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^ac(?=\d)/i, "");
}

export function acfunViewFromSearch(value: string | null): AcfunView {
  return value === "article" ? "article" : "video";
}

export function acfunHomePath(
  view: AcfunView = "video",
  selection: { section?: string | null; channel?: string | null } = {},
): string {
  const params = new URLSearchParams({ [VIDEO_SOURCE_PARAM]: ACFUN_SOURCE });
  if (view !== "video") params.set(ACFUN_VIEW_PARAM, view);
  if (view === "video" && selection.section) {
    params.set(ACFUN_SECTION_PARAM, selection.section);
  }
  if (view === "article" && selection.channel) {
    params.set(ACFUN_CHANNEL_PARAM, selection.channel);
  }
  return `/video?${params.toString()}`;
}

export function acfunSearchPath(view: AcfunView, keyword?: string | null): string {
  const params = new URLSearchParams();
  if (view !== "video") params.set(ACFUN_VIEW_PARAM, view);
  const trimmed = (keyword ?? "").trim();
  if (trimmed) params.set(ACFUN_SEARCH_QUERY_PARAM, trimmed);
  const query = params.toString();
  return `${ACFUN_SEARCH_PATH}${query ? `?${query}` : ""}`;
}

export function acfunVideoPath(id: string, partId?: string | null): string {
  const params = new URLSearchParams({ id: acfunContentId(id) });
  if (partId) params.set("part", partId);
  return `${ACFUN_PLAY_PATH}?${params.toString()}`;
}

export function acfunArticlePath(id: string): string {
  return `${ACFUN_ARTICLE_PATH}/${encodeURIComponent(id)}`;
}

export type AcfunArticleBackNavigation = { kind: "back" } | { kind: "navigate"; path: string };

/**
 * 应用内进入文章时优先返回真实来源，保留频道、搜索词以及分页位置。
 * 从外部直链进入时才使用文章首页。
 */
export function acfunArticleBackNavigation(historyState: unknown): AcfunArticleBackNavigation {
  return canNavigateBackInApp(historyState)
    ? { kind: "back" }
    : { kind: "navigate", path: acfunHomePath("article") };
}

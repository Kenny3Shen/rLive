import { invokeCmd } from "@/shared/api/tauri";
import type {
  AcfunArticleChannel,
  AcfunArticleDetail,
  AcfunArticleListPage,
  AcfunVideoDetail,
  AcfunVideoListPage,
  AcfunVideoPlayInfo,
  AcfunVideoSection,
} from "./acfunTypes";

export function acfunVideoGetRecommend(page: number, pageSize = 20): Promise<AcfunVideoListPage> {
  return invokeCmd<AcfunVideoListPage>("acfun_video_get_recommend", { page, pageSize });
}

export function acfunVideoGetSections(): Promise<AcfunVideoSection[]> {
  return invokeCmd<AcfunVideoSection[]>("acfun_video_get_sections");
}

export function acfunVideoGetSection(sectionId: string, page: number): Promise<AcfunVideoListPage> {
  return invokeCmd<AcfunVideoListPage>("acfun_video_get_section", { sectionId, page });
}

export function acfunVideoSearch(keyword: string, page: number): Promise<AcfunVideoListPage> {
  return invokeCmd<AcfunVideoListPage>("acfun_video_search", { keyword, page });
}

export function acfunVideoGetDetail(id: string): Promise<AcfunVideoDetail> {
  return invokeCmd<AcfunVideoDetail>("acfun_video_get_detail", { id });
}

export function acfunVideoGetPlayInfo(params: {
  videoId: string;
  partId?: string | null;
  quality?: string | null;
}): Promise<AcfunVideoPlayInfo> {
  return invokeCmd<AcfunVideoPlayInfo>("acfun_video_get_play_info", {
    videoId: params.videoId,
    partId: params.partId ?? null,
    quality: params.quality ?? null,
  });
}

export function acfunVideoStopPlay(sessionId: string): Promise<void> {
  if (!sessionId) return Promise.resolve();
  return invokeCmd<void>("acfun_video_stop_play", { sessionId }).catch(() => undefined);
}

export function acfunArticleGetChannels(): Promise<AcfunArticleChannel[]> {
  return invokeCmd<AcfunArticleChannel[]>("acfun_article_get_channels");
}

export function acfunArticleGetFeed(
  channelId: string | null,
  cursor?: string | null,
): Promise<AcfunArticleListPage> {
  return invokeCmd<AcfunArticleListPage>("acfun_article_get_feed", {
    channelId,
    cursor: cursor || null,
  });
}

export function acfunArticleSearch(keyword: string, page: number): Promise<AcfunArticleListPage> {
  return invokeCmd<AcfunArticleListPage>("acfun_article_search", { keyword, page });
}

export function acfunArticleGetDetail(id: string): Promise<AcfunArticleDetail> {
  return invokeCmd<AcfunArticleDetail>("acfun_article_get_detail", { id });
}

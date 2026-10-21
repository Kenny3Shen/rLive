import { replace, type LoaderFunctionArgs } from "react-router-dom";
import { BILIBILI_SHORTS_PATH, SHORTS_SEED_PARAM } from "@/features/shorts/shortsFeed";
import { VIDEO_HOME_PATH } from "@/features/video/videoRoute";

/**
 * 旧 `/shorts` 入口的落点。带有效 seed 的深链仍然直达 B 站推荐流，并原样保留
 * 其余 query；没有 seed 时回视频发现页，不把无关参数带过去。
 *
 * 路由 loader 与路由模块预加载共用这一条判定，避免两处各写一套解析规则。
 */
export function legacyShortsRedirectTarget(search: string): string {
  if (!new URLSearchParams(search).get(SHORTS_SEED_PARAM)?.trim()) return VIDEO_HOME_PATH;
  // 原样转发 query，不重新序列化：旧深链里的其他参数与编码保持不变。
  return `${BILIBILI_SHORTS_PATH}${search}`;
}

/**
 * 旧的短视频平台选择页已下线。这里只在 loader 阶段 replace，不挂载播放器：
 * 有效 seed 转到 B 站推荐流，其余情况回视频发现页。
 */
export function legacyShortsRedirect({ request }: LoaderFunctionArgs): Response {
  return replace(legacyShortsRedirectTarget(new URL(request.url).search));
}

/** 旧抖音入口在 loader 阶段 replace 回视频发现页，不挂播放器，也不转发 query。 */
export function legacyDouyinShortsRedirect(): Response {
  return replace(VIDEO_HOME_PATH);
}

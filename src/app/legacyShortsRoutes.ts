import { replace } from "react-router-dom";
import { SHORTS_PATH } from "@/features/shorts/shortsFeed";

/** 旧抖音入口在 loader 阶段 replace 回选择页，不挂播放器，也不转发 seed 等 query。 */
export function legacyDouyinShortsRedirect(): Response {
  return replace(SHORTS_PATH);
}

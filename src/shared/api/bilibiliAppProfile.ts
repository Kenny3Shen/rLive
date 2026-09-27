/**
 * B 站 APP（TV 扫码）授权的状态查询与失效识别。
 *
 * 抽成共享模块的原因：状态查询原先只存在于设置页，导致「凭据失效」这个事实
 * 只有打开设置页才被发现。现在启动期检查与推荐流错误提示都要用同一份查询与
 * 同一套错误码判定，复制一份类型和 query key 会让两处悄悄漂移。
 *
 * 上游 feed 对无效令牌返回 `code=0`（静默降级匿名流，见
 * `src-tauri/src/account/bilibili_app.rs` 的实测注释），因此推荐流本身不会暴露
 * 失效；失效只在 `oauth2/info` 校验路径被识别，并以 `bilibili_app_auth_required`
 * 返回。
 */

import { isTauri } from "@tauri-apps/api/core";
import { invokeCmd } from "@/shared/api/tauri";
import type { AppError } from "@/shared/types/error";

/** 与后端 `AccountStatus` 的 serde 表示一致。 */
export type BilibiliAppStatus = "none" | "valid" | "expired" | "unknown";

export type BilibiliAppProfile = {
  status: BilibiliAppStatus;
  has_token: boolean;
  mid: string | null;
  expires_at: number | null;
};

export const BILIBILI_APP_PROFILE_QUERY_KEY = ["bilibili_app_profile"] as const;

export const EMPTY_BILIBILI_APP_PROFILE: BilibiliAppProfile = {
  status: "none",
  has_token: false,
  mid: null,
  expires_at: null,
};

/** 凭据已被服务端明确拒绝，必须重新扫码；重试不会成功。 */
export const BILIBILI_APP_AUTH_REQUIRED = "bilibili_app_auth_required";

/** 无法确认（网络、风控、服务故障）；凭据可能仍然有效，重试有意义。 */
export const BILIBILI_APP_AUTH_UNAVAILABLE = "bilibili_app_auth_unavailable";

/** 设置页账号分区：重新扫码与查看状态的唯一入口。 */
export const BILIBILI_APP_AUTH_SETTINGS_PATH = "/settings?section=account";

export function fetchBilibiliAppProfile(): Promise<BilibiliAppProfile> {
  return isTauri()
    ? invokeCmd<BilibiliAppProfile>("account_bilibili_app_profile")
    : Promise.resolve(EMPTY_BILIBILI_APP_PROFILE);
}

export function errorCodeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as AppError).code);
  }
  return null;
}

/**
 * 是否为「需要重新授权」的失败。
 *
 * 只认这一个码：`unavailable` 不能算进来，否则网络抖动会把用户骗去重新扫码，
 * 而凭据其实还是好的。
 */
export function isBilibiliAppAuthRequired(error: unknown): boolean {
  return errorCodeOf(error) === BILIBILI_APP_AUTH_REQUIRED;
}

import { Link } from "react-router-dom";
import { QrCode } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  BILIBILI_APP_AUTH_SETTINGS_PATH,
  isBilibiliAppAuthRequired,
} from "@/shared/api/bilibiliAppProfile";

/**
 * 推荐流失败时的「重新授权」入口。
 *
 * 只在错误码确实是凭据失效时出现：`bilibili_app_auth_unavailable`（网络、风控）
 * 重试才有意义，给用户一个「去重新扫码」的按钮会把他引到没用的路径上。错误码
 * 判定集中在 `bilibiliAppProfile`，两个调用点不各自比较字符串。
 *
 * 用户仍保留「重试」按钮（由 `ErrorState` 渲染）：失效判定万一有误，重试是
 * 成本更低的恢复方式。
 */
export function BilibiliAppAuthAction({ error }: { error: unknown }) {
  if (!isBilibiliAppAuthRequired(error)) return null;
  return (
    <Link
      to={BILIBILI_APP_AUTH_SETTINGS_PATH}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <QrCode data-icon="inline-start" aria-hidden />
      去重新授权
    </Link>
  );
}

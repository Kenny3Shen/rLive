import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { notify } from "@/components/ui/toast";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { fetchBilibiliAppProfile } from "@/shared/api/bilibiliAppProfile";
import { invalidateBilibiliAppQueries } from "@/shared/api/bilibiliAppQueryInvalidation";

/**
 * 启动期后台校验一次 APP 授权，失效时告知用户。
 *
 * 为什么需要：上游 feed 对无效令牌返回 `code=0`（静默降级匿名流），所以推荐页
 * 不会报错，用户只会发现「推荐好像不太对」而无从判断。只有 `oauth2/info` 校验
 * 能识别失效。放在启动期是为了在用户打开推荐之前就说清楚，而不是让他先看一段
 * 匿名流。
 *
 * 刻意不做的事：
 * - 不自动清除凭据。网络失败、风控、上游故障都会让校验失败，删掉用户仍可能
 *   可用的凭据无法恢复；清理始终是用户的显式动作。
 * - 不阻塞首屏。延迟执行，且失败完全静默 —— 校验本身出问题时不应影响启动。
 * - 不重复打扰。每个授权版本只提示一次；重扫或移除授权后（`authRevision` 变化）
 *   才重新检查。
 */
const STARTUP_CHECK_DELAY_MS = 1_200;

export function BilibiliAppAuthStartupCheck() {
  const queryClient = useQueryClient();
  const hydratedFromBackend = useSettingsStore((state) => state.hydratedFromBackend);
  const authRevision = useSettingsStore((state) => state.bilibiliAppAuthRevision);
  /** 已检查过的授权版本；-1 保证首次挂载必然检查一次。 */
  const checkedRevisionRef = useRef(-1);

  useEffect(() => {
    if (!hydratedFromBackend || checkedRevisionRef.current === authRevision) return;
    let cancelled = false;
    const timerId = window.setTimeout(() => {
      if (cancelled) return;
      void fetchBilibiliAppProfile()
        .then((profile) => {
          if (cancelled) return;
          checkedRevisionRef.current = authRevision;
          // 只有服务端明确拒绝才算失效；`unknown` 是没能确认，不该提示重扫。
          if (!profile.has_token || profile.status !== "expired") return;
          // 丢弃旧账号的列表缓存，否则推荐页仍会拿它当新鲜数据。
          void invalidateBilibiliAppQueries(queryClient);
          notify.error(
            "Bilibili TV 授权已失效",
            "个性化推荐已不可用。请到「设置 → 账号 → 平台账号」重新扫码。",
          );
        })
        .catch(() => {
          // 校验失败（网络、上游故障）不代表凭据失效，保持静默。
        });
    }, STARTUP_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [authRevision, hydratedFromBackend, queryClient]);

  return null;
}

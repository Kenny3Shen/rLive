/**
 * 账号卡片的状态呈现与「是否允许自动清理凭据」判定。
 *
 * 抽成纯函数的原因：这里区分的是「平台确认登录」「平台明确拒绝」「没能验证」
 * 三种不同事实，而自动登出会**删除用户凭据**。把判定留在组件里就只能靠读代码
 * 确认，无法回归；一旦有人把 `unknown` 与 `expired` 合并，删除行为会在无测试
 * 保护下复活。
 */

/** 与后端 `AccountStatus` 的 serde 表示一致。 */
export type AccountStatus = "none" | "valid" | "expired" | "unknown";

export type AccountPresentation = {
  /** 徽标文案。 */
  label: string;
  /** 徽标视觉语气：危险色只留给确定失效。 */
  tone: "destructive" | "secondary" | "outline";
  /** 是否展示「已保存但未验证」的说明。 */
  showUnverifiedHint: boolean;
  /** 是否允许据此状态自动删除本机 Cookie。 */
  autoClearCookie: boolean;
};

/**
 * 只把**平台明确拒绝**（`expired`）当作失效证据。
 *
 * `unknown` 表示探针没跑完（网络失败、风控、限流）或该平台没有低成本验证手段，
 * 它既不能升级成「已登录」，也**不能**降级成「已失效」——后者会删掉用户仍可用的
 * Cookie。`valid` 时若没有可展示的名字，仍然显示为已登录，只是不显示名字。
 */
export function accountPresentation(
  status: AccountStatus,
  hasCookie: boolean,
  loading: boolean,
): AccountPresentation {
  if (loading) {
    return {
      label: "读取中",
      tone: "outline",
      showUnverifiedHint: false,
      autoClearCookie: false,
    };
  }
  if (status === "expired" && hasCookie) {
    return {
      label: "已失效",
      tone: "destructive",
      showUnverifiedHint: false,
      autoClearCookie: true,
    };
  }
  if (status === "unknown" && hasCookie) {
    return {
      label: "已保存，未验证",
      tone: "outline",
      showUnverifiedHint: true,
      autoClearCookie: false,
    };
  }
  if (hasCookie) {
    // valid：平台已确认会话，名字是可选的展示字段。
    return {
      label: "已登录",
      tone: "secondary",
      showUnverifiedHint: false,
      autoClearCookie: false,
    };
  }
  return {
    label: "未登录",
    tone: "outline",
    showUnverifiedHint: false,
    autoClearCookie: false,
  };
}

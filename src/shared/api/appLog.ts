import { invokeCmd } from "./tauri";

/**
 * 把前端诊断写进应用日志 `rlive.log`（设置 → 日志可查看）。
 *
 * 后端会去掉 URL 的 query、折叠多行并限制长度。写日志失败不影响任何界面，
 * 因此这里吞掉错误：诊断通道本身出问题时没有更合适的地方可以报告。
 */
export function reportAppLog(source: string, message: string): void {
  void invokeCmd<void>("app_log_report", { source, message }).catch(() => {});
}

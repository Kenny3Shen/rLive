import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { CircleDot, LogOut } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { notify } from "@/components/ui/toast";
import {
  activeRecordingCount,
  confirmAppExit,
  fetchActiveRecordingCount,
  recordingErrorMessage,
  recordingSupported,
  useRecordings,
} from "./recording";

/** 任务运行期间由窗口关闭处理器发出，而不是直接关闭窗口。 */
const APP_EXIT_REQUESTED_EVENT = "app-exit-requested";

/**
 * 在录制仍在采集时确认应用退出。
 *
 * 录制在其播放器页离开后仍继续运行，关闭窗口可能悄悄丢弃进行中的任务。
 * Rust 关闭处理器阻止关闭并发出 `app-exit-requested`；
 * 这个对话框就是回答。确认后通过 `app_confirm_exit` 停止每个任务，
 * 使它们在进程退出前完成媒体、弹幕伴生文件和元数据的收尾。
 */
export function RecordingExitGuard() {
  const supported = recordingSupported();
  const recordings = useRecordings(supported);
  // 后端随关闭请求上报的数量。它是权威且最新的；库查询是缓存且背后是 15 秒轮询，
  // 刚刚开始或结束的任务仍会被数错。
  const [reportedCount, setReportedCount] = useState<number | null>(null);
  const cachedCount = activeRecordingCount(recordings.data);
  // 上报的数量只能说明任务*曾经*在运行。一旦事件驱动的列表显示没有任务在采集，
  // 那才是更新的事实，下方的自动退出可以据此执行。
  const activeCount =
    recordings.isSuccess && cachedCount === 0 ? 0 : (reportedCount ?? cachedCount);
  // 后端只在有活动任务时才询问，所以列表未解析意味着"未知"而不是"没有"。
  // 自动退出会等待它，而不是跳过本应由用户回答的问题。
  const countKnown = reportedCount !== null || recordings.isSuccess;
  const [open, setOpen] = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const cleanup = await listen(APP_EXIT_REQUESTED_EVENT, () => {
          setOpen(true);
          // 对文案尽力优化。失败时保留缓存数量 —— 它至少给出一个数字而不是空白。
          void fetchActiveRecordingCount()
            .then((count) => setReportedCount(count))
            .catch(() => undefined);
        });
        if (disposed) cleanup();
        else unlisten = cleanup;
      } catch {
        // 没有这个监听器，关闭处理器的 emit 会失败，
        // 后端将自行兜底：停止任务并退出。
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [supported]);

  // 最后一个任务可能在关闭请求与应答之间完成。此时已无风险，
  // 立即退出，而不是就零个任务发问。
  useEffect(() => {
    if (!open || exiting || !countKnown || activeCount > 0) return;
    setExiting(true);
    void confirmAppExit().catch((error) => {
      notify.error("退出应用失败", recordingErrorMessage(error));
      setExiting(false);
      setOpen(false);
    });
  }, [activeCount, countKnown, exiting, open]);

  async function exitAndStopRecordings() {
    if (exiting) return;
    setExiting(true);
    try {
      await confirmAppExit();
    } catch (error) {
      // invoke 被拒绝说明进程仍在，因此把错误展示出来并保持窗口打开，
      // 而不是让一个失效的对话框留在屏幕上。
      notify.error("退出应用失败", recordingErrorMessage(error));
      setExiting(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !exiting) setOpen(false);
      }}
      icon={<CircleDot aria-hidden />}
      title={activeCount > 0 ? `还有 ${activeCount} 项录制正在进行` : "录制仍在进行"}
      description="退出应用会结束所有录制任务，已录制的内容会先保存再退出。确定继续退出吗？"
      cancelText="继续录制"
      busy={exiting}
      busyText="正在保存并退出…"
      actionIcon={<LogOut data-icon="inline-start" aria-hidden />}
      confirmText="结束录制并退出"
      onConfirm={() => void exitAndStopRecordings()}
    />
  );
}

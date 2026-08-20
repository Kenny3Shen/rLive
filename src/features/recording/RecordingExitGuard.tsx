import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { CircleDot, LogOut } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import {
  activeRecordingCount,
  confirmAppExit,
  recordingErrorMessage,
  recordingSupported,
  useRecordings,
} from "./recording";

/** Emitted by the window close handler instead of closing while tasks run. */
const APP_EXIT_REQUESTED_EVENT = "app-exit-requested";

/**
 * Confirms application exit while recordings are still capturing.
 *
 * Recording continues after its player page is left, so a window close can
 * silently discard an active task. The Rust close handler prevents the close and
 * emits `app-exit-requested`; this dialog is the answer. Confirming stops every
 * task through `app_confirm_exit` so each one finalizes its media, danmaku
 * sidecar, and metadata before the process leaves.
 */
export function RecordingExitGuard() {
  const supported = recordingSupported();
  const recordings = useRecordings(supported);
  const activeCount = activeRecordingCount(recordings.data);
  // The backend only asks when it has active tasks, so an unresolved list means
  // "unknown", not "none". Auto-exit waits for it rather than skipping the
  // question the user was supposed to answer.
  const countKnown = recordings.isSuccess;
  const [open, setOpen] = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const cleanup = await listen(APP_EXIT_REQUESTED_EVENT, () => setOpen(true));
        if (disposed) cleanup();
        else unlisten = cleanup;
      } catch {
        // Without the listener the close handler's emit fails and the backend
        // falls back to stopping tasks and exiting on its own.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [supported]);

  // The last task may finish between the close request and the answer. Nothing
  // is at risk then, so leave immediately rather than asking about zero tasks.
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
      // A rejected invoke means the process is still here, so surface it and
      // keep the window open instead of leaving a dead dialog on screen.
      notify.error("退出应用失败", recordingErrorMessage(error));
      setExiting(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !exiting) setOpen(false);
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <CircleDot aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {activeCount > 0 ? `还有 ${activeCount} 项录制正在进行` : "录制仍在进行"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            退出应用会结束所有录制任务，已录制的内容会先保存再退出。确定继续退出吗？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={exiting}>继续录制</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant="destructive"
            disabled={exiting}
            onClick={() => void exitAndStopRecordings()}
          >
            {exiting ? (
              <Spinner data-icon="inline-start" aria-hidden />
            ) : (
              <LogOut data-icon="inline-start" aria-hidden />
            )}
            {exiting ? "正在保存并退出…" : "结束录制并退出"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

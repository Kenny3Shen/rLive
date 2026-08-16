import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "react-router-dom";
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
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { CircleDot, LogOut, Square } from "lucide-react";
import {
  activeRecordingForContext,
  RECORDINGS_QUERY_KEY,
  recordingErrorMessage,
  stopRecording,
  useRecordings,
  type RecordingContext,
  type RecordingItem,
} from "./recording";

export function shouldPromptBeforeRecordingLeave(
  item: Pick<RecordingItem, "status" | "continue_on_leave"> | null,
  currentTarget: string,
  nextTarget: string,
): boolean {
  return item?.status === "recording" && !item.continue_on_leave && currentTarget !== nextTarget;
}

function locationTarget(location: { pathname: string; search: string; hash: string }): string {
  return location.pathname + location.search + location.hash;
}

/** Blocks every in-app navigation path while the current recording has not
 * explicitly opted into background continuation. */
export function RecordingLeaveGuard({ context }: { context: RecordingContext | null }) {
  const queryClient = useQueryClient();
  const recordings = useRecordings();
  const active = activeRecordingForContext(recordings.data, context);
  const [stopping, setStopping] = useState(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    shouldPromptBeforeRecordingLeave(
      active,
      locationTarget(currentLocation),
      locationTarget(nextLocation),
    ),
  );

  useEffect(() => {
    if (blocker.state === "blocked" && !active && !stopping) blocker.proceed();
  }, [active, blocker, stopping]);

  const pageLabel = context?.sourceKind === "iptv" ? "频道" : "直播间";
  const open = blocker.state === "blocked";

  function stayOnPage() {
    if (blocker.state === "blocked" && !stopping) blocker.reset();
  }

  function continueAndLeave() {
    if (blocker.state === "blocked" && !stopping) blocker.proceed();
  }

  async function stopAndLeave() {
    if (blocker.state !== "blocked" || !active || stopping) return;
    const proceed = blocker.proceed;
    const item = active;
    setStopping(true);
    try {
      const stopped = await stopRecording(item.id);
      queryClient.setQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY, (current) =>
        (current ?? []).map((entry) => (entry.id === stopped.id ? stopped : entry)),
      );
      void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
      notify.success("录制已保存", stopped.title);
      setStopping(false);
      proceed();
    } catch (error) {
      notify.error("停止录制失败", recordingErrorMessage(error));
      setStopping(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) stayOnPage();
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <CircleDot aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle>录制仍在进行</AlertDialogTitle>
          <AlertDialogDescription>
            “{active?.title || context?.title || `当前${pageLabel}`}”正在录制。离开{pageLabel}
            前请选择如何处理这次录制。
            {active?.include_danmaku && " 继续录制媒体时，弹幕会随直播间连接结束而停止收集。"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="sm:flex-wrap">
          <AlertDialogCancel disabled={stopping} onClick={stayOnPage}>
            留在{pageLabel}
          </AlertDialogCancel>
          <Button type="button" variant="outline" disabled={stopping} onClick={continueAndLeave}>
            <LogOut data-icon="inline-start" aria-hidden />
            继续录制并离开
          </Button>
          <AlertDialogAction type="button" disabled={stopping || !active} onClick={stopAndLeave}>
            {stopping ? (
              <Spinner data-icon="inline-start" aria-hidden />
            ) : (
              <Square data-icon="inline-start" aria-hidden />
            )}
            {stopping ? "正在保存…" : "停止录制并离开"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

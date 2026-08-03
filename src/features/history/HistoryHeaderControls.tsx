import { Trash2 } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useHistoryShellStore } from "./historyShellStore";

export function HistoryHeaderControls() {
  const activeTab = useHistoryShellStore((state) => state.activeTab);
  const canClear = useHistoryShellStore((state) => state.canClear);
  const clearPending = useHistoryShellStore((state) => state.clearPending);
  const clearError = useHistoryShellStore((state) => state.clearError);
  const clearOpen = useHistoryShellStore((state) => state.clearOpen);
  const clearTitle = useHistoryShellStore((state) => state.clearTitle);
  const clearDescription = useHistoryShellStore((state) => state.clearDescription);
  const setClearOpen = useHistoryShellStore((state) => state.setClearOpen);
  const resetActiveMutation = useHistoryShellStore((state) => state.resetActiveMutation);
  const clearActiveHistory = useHistoryShellStore((state) => state.clearActiveHistory);

  return (
    <AlertDialog
      open={clearOpen}
      onOpenChange={(open) => {
        if (clearPending) return;
        if (open) resetActiveMutation();
        setClearOpen(open);
      }}
    >
      <AlertDialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={!canClear || clearPending}
            aria-label={activeTab === "watch" ? "清空观看历史" : "清空发送弹幕记录"}
          >
            <Trash2 data-icon="inline-start" aria-hidden />
            <span className="max-md:hidden">清空</span>
          </Button>
        }
      />
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2 aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle>{clearTitle}</AlertDialogTitle>
          <AlertDialogDescription>{clearDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        {clearError && (
          <p role="alert" className="text-sm text-destructive">
            清空失败，请重试。
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={clearPending}>取消</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant="destructive"
            disabled={clearPending}
            onClick={clearActiveHistory}
          >
            {clearPending ? (
              <>
                <Spinner data-icon="inline-start" aria-hidden />
                清空中…
              </>
            ) : (
              <>
                <Trash2 data-icon="inline-start" aria-hidden />
                清空
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

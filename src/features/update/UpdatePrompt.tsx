import { useEffect, useRef } from "react";
import { ArrowUpCircle, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateStore, releaseNotes } from "@/shared/update/updateStore";
import { Markdown } from "@/shared/markdown/Markdown";

const PROJECT_RELEASES_URL = "https://github.com/Kenny3Shen/rLive/releases";

function openExternalUrl(url: string): void {
  void openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

export function UpdatePrompt() {
  const release = useUpdateStore((state) => state.release);
  const dialogOpen = useUpdateStore((state) => state.dialogOpen);
  const dismissDialog = useUpdateStore((state) => state.dismissDialog);

  return (
    <Dialog open={dialogOpen} onOpenChange={(open) => !open && dismissDialog()}>
      <DialogContent className="gap-5 sm:max-w-lg">
        <DialogHeader className="gap-3">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/12 text-primary ring-1 ring-primary/15">
            <ArrowUpCircle className="size-6" aria-hidden />
          </div>
          <div className="flex items-center gap-2">
            <DialogTitle>发现新版本</DialogTitle>
            {release && (
              <span className="rounded-full bg-primary/12 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">
                v{release.version}
              </span>
            )}
          </div>
          <DialogDescription>
            {release ? release.name : "rLive 有新的版本可供查看。"}
          </DialogDescription>
        </DialogHeader>
        {release && (
          <div className="max-h-60 overflow-y-auto rounded-lg border border-border-subtle bg-muted/25 px-3.5 py-3 text-sm text-muted-foreground">
            <Markdown>{releaseNotes(release)}</Markdown>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={dismissDialog}>
            稍后提醒
          </Button>
          <Button
            onClick={() => {
              openExternalUrl(release?.htmlUrl ?? PROJECT_RELEASES_URL);
              dismissDialog();
            }}
          >
            <ExternalLink data-icon="inline-start" aria-hidden />
            查看更新
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UpdateChecker() {
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  const didStartRef = useRef(false);

  useEffect(() => {
    if (didStartRef.current) return;
    didStartRef.current = true;
    void checkForUpdate().catch(() => {});
  }, [checkForUpdate]);

  return <UpdatePrompt />;
}

export function openReleasePage(url: string): void {
  openExternalUrl(url);
}

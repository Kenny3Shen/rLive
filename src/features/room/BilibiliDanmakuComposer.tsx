import { useEffect, useState, type KeyboardEvent } from "react";
import { SendHorizontal } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteId } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type SendStatus = {
  experimental_enabled: boolean;
  cookie_ready: boolean;
  available: boolean;
  message: string;
};

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: string }).message);
  }
  return "发送失败，请稍后重试";
}

/**
 * Deliberately tiny Bilibili-only composer. It never creates a local chat
 * row; the live websocket remains responsible for showing the server echo.
 */
export function BilibiliDanmakuComposer({ siteId, roomId }: { siteId?: SiteId; roomId?: string }) {
  const experimentalEnabled = useSettingsStore((s) => s.bilibiliDanmakuSendEnabled);
  const sendSettingPending = useSettingsStore((s) => s.bilibiliDanmakuSendPending);
  const [availability, setAvailability] = useState<SendStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (siteId !== "bilibili") return;
    let cancelled = false;
    setAvailability(null);
    // Do not ask the backend while the explicit opt-in is still queued for
    // persistence. Once it settles this effect runs again, preventing a stale
    // disabled status from pinning the composer until the user re-enters.
    if (sendSettingPending) {
      setAvailability({
        experimental_enabled: experimentalEnabled,
        cookie_ready: false,
        available: false,
        message: "正在同步发送权限…",
      });
      return () => {
        cancelled = true;
      };
    }
    void invokeCmd<SendStatus>("bilibili_danmaku_send_status")
      .then((status) => {
        if (!cancelled) setAvailability(status);
      })
      .catch(() => {
        if (!cancelled) {
          setAvailability({
            experimental_enabled: false,
            cookie_ready: false,
            available: false,
            message: "暂时无法确认 B站发送权限",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [siteId, roomId, experimentalEnabled, sendSettingPending]);

  if (siteId !== "bilibili" || !roomId) return null;

  const ready = availability?.available === true;
  const canSubmit = ready && draft.trim().length > 0 && !sending;

  function requestConfirmation() {
    if (!canSubmit) return;
    setResult(null);
    setConfirmOpen(true);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      requestConfirmation();
    }
  }

  async function send() {
    if (!canSubmit) return;
    setSending(true);
    setResult(null);
    try {
      await invokeCmd<void>("bilibili_danmaku_send", {
        roomId,
        message: draft.trim(),
      });
      setDraft("");
      setConfirmOpen(false);
      setResult("已提交，等待直播间回显。");
    } catch (error) {
      setConfirmOpen(false);
      setResult(`发送失败：${errorMessage(error)}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="shrink-0 border-t border-border-subtle bg-sidebar/80 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={availability?.message ?? "正在检查发送权限…"}
          disabled={!ready || sending}
          maxLength={80}
          aria-label="B站弹幕内容"
          className="h-8 min-w-0 text-sm"
        />
        <Button
          size="icon"
          disabled={!canSubmit}
          onClick={requestConfirmation}
          aria-label="发送 B站弹幕"
          title="发送（需确认）"
        >
          <SendHorizontal />
        </Button>
      </div>
      <p className="mt-1.5 min-h-4 text-[11px] leading-4 text-muted-foreground">
        {result ?? availability?.message ?? "正在检查发送权限…"}
      </p>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>确认发送弹幕？</AlertDialogTitle>
            <AlertDialogDescription>
              将向当前 B站直播间发送：{draft.trim() || "（空内容）"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!canSubmit} onClick={() => void send()}>
              {sending ? "发送中…" : "确认发送"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

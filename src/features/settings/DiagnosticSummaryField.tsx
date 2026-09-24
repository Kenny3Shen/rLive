import { useMutation } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, FileDown, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { invokeCmd } from "@/shared/api/tauri";
import { isMobileClient } from "@/shared/clientPlatform";
import { copyText } from "@/shared/clipboard";
import { playbackTelemetrySnapshots } from "@/features/room/player/playbackTelemetry";
import {
  diagnosticSections,
  renderDiagnosticSummary,
  type DiagnosticSection,
  type DiagnosticSnapshot,
} from "./diagnosticSummary";

export function DiagnosticSummaryField() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ at: number; sections: DiagnosticSection[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0);
  const mobile = isMobileClient();
  const collect = useMutation({
    mutationFn: () => invokeCmd<DiagnosticSnapshot>("app_diagnostic_snapshot"),
  });

  let text = "";
  let previewError: string | null = null;
  if (draft) {
    try {
      text = renderDiagnosticSummary(draft.at, draft.sections);
    } catch {
      previewError = "摘要超过 128 KiB，请移除部分字段后重试。";
    }
  }

  async function generate() {
    const request = ++generation.current;
    setDraft(null);
    setError(null);
    setStatus(null);
    try {
      const backend = await collect.mutateAsync();
      if (generation.current !== request) return;
      setDraft({
        at: backend.generated_at_ms,
        sections: diagnosticSections(backend, playbackTelemetrySnapshots(), navigator.userAgent),
      });
    } catch {
      if (generation.current === request)
        setError("生成失败，请重试。不会自动保存或上传任何内容。");
    }
  }

  async function exportPreview(method: "copy" | "save") {
    if (!text || exporting) return;
    const request = generation.current;
    // 冻结这次用户确认的预览；保存位置对话框期间不重新生成或采样。
    const preview = text;
    setExporting(true);
    setError(null);
    setStatus(null);
    try {
      if (method === "copy") {
        if (!(await copyText(preview))) throw new Error("copy_failed");
        if (request === generation.current) setStatus("已复制预览内容。");
      } else {
        const path = await save({
          title: "保存诊断摘要",
          defaultPath: "rlive-diagnostic.json",
          filters: [{ name: "诊断摘要", extensions: ["json"] }],
        });
        // 取消或关闭预览后不写文件。
        if (!path || request !== generation.current) return;
        await invokeCmd("app_diagnostic_export", { path, text: preview });
        if (request === generation.current) setStatus("已保存预览内容。");
      }
    } catch {
      if (request === generation.current)
        setError(method === "copy" ? "复制失败，可尝试保存摘要。" : "保存失败，请重试或复制摘要。");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void generate();
        } else {
          generation.current += 1;
          setDraft(null);
          setError(null);
          setStatus(null);
        }
      }}
    >
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>诊断摘要</FieldTitle>
          <FieldDescription>
            仅生成本机白名单信息，先预览、移除字段，再保存或复制。
          </FieldDescription>
        </FieldContent>
        <DrawerTrigger
          render={
            <Button variant="outline">
              <ShieldCheck data-icon="inline-start" aria-hidden />
              生成诊断摘要
            </Button>
          }
        />
      </Field>
      <DrawerContent
        side={mobile ? "bottom" : "right"}
        className="flex flex-col gap-3 overflow-hidden w-[min(48rem,100vw)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-2">
          <DrawerTitle>诊断摘要预览</DrawerTitle>
          <DrawerClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭诊断摘要" />}>
            <X aria-hidden />
          </DrawerClose>
        </div>
        <DrawerDescription>
          不包含原始日志正文、地址、用户路径、观看内容、字幕、聊天或凭据。不会自动上传。
          可移除下列字段；保存和复制仅使用当前预览。
        </DrawerDescription>
        {draft && (
          <>
            <FieldDescription>
              生成于 {new Date(draft.at).toLocaleString()}；日志按文件尾部取样，播放仅取最近 10
              分钟内最多 24 条。
            </FieldDescription>
            <div className="flex shrink-0 flex-wrap gap-2" aria-label="移除诊断字段">
              {draft.sections.map((section) => (
                <Button
                  key={section.id}
                  variant="outline"
                  size="sm"
                  disabled={exporting}
                  aria-label={`移除${section.label}`}
                  onClick={() => {
                    setDraft({
                      ...draft,
                      sections: draft.sections.filter((item) => item.id !== section.id),
                    });
                    setStatus(null);
                  }}
                >
                  <X data-icon="inline-start" aria-hidden />
                  {section.label}
                </Button>
              ))}
            </div>
          </>
        )}
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/40 p-3">
          {collect.isPending ? (
            <div className="flex items-center gap-2" role="status">
              <Spinner aria-hidden />
              正在生成本机摘要…
            </div>
          ) : (
            <pre
              aria-label="诊断摘要内容"
              className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed"
            >
              {text || "暂无可预览内容"}
            </pre>
          )}
        </div>
        {(error || previewError) && <FieldError role="alert">{error || previewError}</FieldError>}
        {status && <FieldDescription role="status">{status}</FieldDescription>}
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={collect.isPending || exporting}
            onClick={() => void generate()}
          >
            <RefreshCw data-icon="inline-start" aria-hidden />
            重新生成
          </Button>
          <Button
            variant="outline"
            disabled={!text || collect.isPending || exporting}
            onClick={() => void exportPreview("copy")}
          >
            <ClipboardCopy data-icon="inline-start" aria-hidden />
            复制摘要
          </Button>
          <Button
            disabled={!text || collect.isPending || exporting}
            onClick={() => void exportPreview("save")}
          >
            <FileDown data-icon="inline-start" aria-hidden />
            保存摘要
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

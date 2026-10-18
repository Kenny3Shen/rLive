import "../styles/theme.css";
import { resolveErrorDialogDescription } from "@videojs/core";
import { translateText } from "@videojs/core/i18n";
import {
  AlertDialog as AlertDialogPrimitive,
  ErrorDialog as ErrorDialogPrimitive,
  useErrorDialogContext,
  useTranslator,
} from "@videojs/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/videojs/ui/button";
import {
  errorMessageLooksTechnical,
  errorPresentation,
} from "@/shared/components/errorPresentation";
import { reportAppLog } from "@/shared/api/appLog";

/** 宿主自己判定的播放失败；传入后弹窗只跟随它，不再跟随 `media.error`。 */
export type PlayerErrorDialogState = {
  /** 宿主当前的失败；null 表示没有失败，弹窗关闭。 */
  error: unknown;
  title: string;
  onRetry?: () => void;
};

const MEDIA_ERROR_TITLE = "播放出错";
const MEDIA_ERROR_FALLBACK = "播放器无法继续播放当前内容。请刷新或切换线路后重试。";

const BACKDROP_CLASS =
  "absolute inset-0 z-40 bg-media-backdrop/20 opacity-100 backdrop-filter-media-dialog not-data-open:hidden transition-opacity delay-media-dialog duration-media-dialog ease-out media-transitioning:opacity-0 data-ending-style:delay-0 data-ending-style:duration-media-slower";
const POPUP_CLASS =
  "absolute top-1/2 left-1/2 z-50 flex w-media-dialog-width max-w-media-dialog max-h-[calc(100%-0.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-media-dialog text-media-popover-foreground outline-hidden not-data-open:hidden text-shadow-media-dialog transition-[opacity,scale] delay-media-dialog duration-media-dialog ease-out media-transitioning:scale-media-hidden-popup media-transitioning:opacity-0 data-ending-style:delay-0 bg-media-popover surface-media after:surface-media-inset p-3 data-ending-style:duration-media-slower";
const BUTTON_CLASS = "h-media-control w-full flex-1 px-4 py-2 font-medium";
const PRIMARY_BUTTON_CLASS = `${BUTTON_CLASS} bg-media-primary! text-media-primary-foreground!`;
const SECONDARY_BUTTON_CLASS = `${BUTTON_CLASS} bg-media-muted!`;

/**
 * 播放器内的错误弹窗，沿用 Video.js 原生对话框的玻璃面板与动效。
 *
 * - 宿主传入 `state` 时由宿主的失败驱动：标题、说明与「重试」都来自宿主，
 *   页面不再另绘一张错误卡，避免与 Video.js 的媒体错误弹窗叠成两层。
 * - 未传入时退回 Video.js `ErrorDialog`，跟随 `media.error` 打开。
 *
 * 两种来源都只给用户看可读的说明；原始报错写进应用日志（设置 → 日志），
 * 不在弹窗里展开。
 */
export function ErrorDialog({ state }: { state?: PlayerErrorDialogState }) {
  return state ? <HostErrorDialog {...state} /> : <MediaErrorDialog />;
}

type ShownError = { key: string; title: string; description: string; technical: string | null };

function HostErrorDialog({ error, title, onRetry }: PlayerErrorDialogState) {
  const current = hostError(error, title);
  // 关闭动效期间宿主的 error 可能已清空，保留上一份内容避免文案闪成兜底句。
  const [shown, setShown] = useState<ShownError | null>(current);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  if (current && current.key !== shown?.key) setShown(current);
  // 失败消失（重试、换源）后清掉关闭记录，同样的失败再次出现时要重新弹出。
  if (!current && dismissedKey !== null) setDismissedKey(null);

  useReportOnce(
    current?.key ?? null,
    current ? `${current.title}：${current.technical ?? current.description}` : null,
  );

  const open = current !== null && current.key !== dismissedKey;
  return (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && current) setDismissedKey(current.key);
      }}
    >
      <DialogFrame
        title={shown?.title ?? title}
        description={shown?.description ?? ""}
        renderClose={(props) => <AlertDialogPrimitive.Close render={<Button />} {...props} />}
        onRetry={onRetry}
      />
    </AlertDialogPrimitive.Root>
  );
}

function hostError(error: unknown, title: string): ShownError | null {
  if (error == null) return null;
  const { description, technical } = errorPresentation(error);
  return { key: `${title}\n${technical ?? description}`, title, description, technical };
}

function MediaErrorDialog() {
  return (
    <ErrorDialogPrimitive.Root>
      <MediaErrorDialogFrame />
    </ErrorDialogPrimitive.Root>
  );
}

/** `lastError` 只能在 ErrorDialog.Root 之内读取。 */
function MediaErrorDialogFrame() {
  const t = useTranslator();
  const { lastError } = useErrorDialogContext();
  const resolved = translateText(resolveErrorDialogDescription(lastError), t).trim();
  const description =
    !resolved || errorMessageLooksTechnical(resolved) ? MEDIA_ERROR_FALLBACK : resolved;
  const raw = lastError?.message?.trim();
  useReportOnce(
    lastError ? `${lastError.code}\n${raw ?? ""}` : null,
    lastError ? `${MEDIA_ERROR_TITLE}：MediaError ${lastError.code}${raw ? ` ${raw}` : ""}` : null,
  );

  return (
    <DialogFrame
      title={MEDIA_ERROR_TITLE}
      description={description}
      renderClose={(props) => <ErrorDialogPrimitive.Close render={<Button />} {...props} />}
    />
  );
}

/** 同一个失败只写一次日志；失败清空后再出现会重新记录。 */
function useReportOnce(key: string | null, message: string | null) {
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (key === null) {
      reported.current = null;
      return;
    }
    if (!message || reported.current === key) return;
    reported.current = key;
    reportAppLog("player", message);
  }, [key, message]);
}

type DialogFrameProps = {
  title: string;
  description: string;
  /** 渲染绑定到对应 Root 的关闭按钮；样式与文案由这里统一给出。 */
  renderClose: (props: { className: string; children: ReactNode }) => ReactNode;
  onRetry?: () => void;
};

// 框架只用通用 Dialog 部件：`ErrorDialog.Description` 会读 ErrorDialog 专属上下文，
// 放在宿主模式的 AlertDialog.Root 下会直接抛错；通用部件两种 Root 都能用。
function DialogFrame({ title, description, renderClose, onRetry }: DialogFrameProps) {
  return (
    <>
      <AlertDialogPrimitive.Backdrop className={BACKDROP_CLASS} />
      <AlertDialogPrimitive.Popup className={POPUP_CLASS}>
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pt-2 pb-1.5">
          <AlertDialogPrimitive.Title className="m-0 text-media-lg font-semibold leading-tight">
            {title}
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="m-0 opacity-70 wrap-anywhere">
            {description}
          </AlertDialogPrimitive.Description>
        </div>
        <div className="flex shrink-0 gap-2">
          {renderClose({
            className: onRetry ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS,
            children: "关闭",
          })}
          {onRetry && (
            <Button type="button" className={PRIMARY_BUTTON_CLASS} onClick={onRetry}>
              重试
            </Button>
          )}
        </div>
      </AlertDialogPrimitive.Popup>
    </>
  );
}

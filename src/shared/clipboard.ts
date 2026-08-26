/**
 * 跨 Tauri WebView、浏览器预览和较旧 WebView 复制纯文本。优先使用现代
 * Clipboard API，并为缺少或拒绝权限的环境提供保留选区的兜底方案。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text || typeof document === "undefined") return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 被拒绝的原生请求仍可能通过下方 execCommand 成功。
  }

  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const activeElement = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  try {
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    try {
      textarea.remove();
    } catch {
      // 清理尽力而为。
    }
    try {
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch {
      // 剪贴板请求进行期间选区可能已经分离。
    }
    try {
      if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
    } catch {
      try {
        activeElement?.focus();
      } catch {
        // 较旧 WebView 可能不支持 focus 选项。
      }
    }
  }
}

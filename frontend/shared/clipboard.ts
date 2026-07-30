/**
 * Copy plain text across Tauri WebView, browser previews, and older WebViews.
 * The modern Clipboard API is preferred, with a selection-preserving fallback
 * for environments where the permission is missing or rejected.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text || typeof document === "undefined") return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A rejected native request can still succeed through execCommand below.
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
      // Cleanup is best-effort only.
    }
    try {
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch {
      // A selection can become detached while the clipboard request is open.
    }
    try {
      if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
    } catch {
      try {
        activeElement?.focus();
      } catch {
        // Older WebViews may not support focus options.
      }
    }
  }
}

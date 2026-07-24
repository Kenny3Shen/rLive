import { invokeCmd } from "@/shared/api/tauri";

export type OverlayBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * A logical fullscreen/windowed danmaku surface.
 *
 * One epoch is allocated per surface, not per resize.  Rust retains the
 * closing epoch as a tombstone, which means a delayed `overlay_open` cannot
 * revive a surface after React has navigated away from it.
 */
export type OverlayEpoch = number;

let currentEpoch: OverlayEpoch | null = null;

export async function beginOverlay(): Promise<OverlayEpoch> {
  // Rust allocates the sequence. It therefore survives a WebView reload and
  // remains ordered across every in-flight IPC request.
  const epoch = await invokeCmd<OverlayEpoch>("overlay_begin");
  if (currentEpoch == null || epoch > currentEpoch) currentEpoch = epoch;
  return epoch;
}

export function isCurrentOverlay(epoch: OverlayEpoch): boolean {
  return currentEpoch === epoch;
}

export function forgetOverlay(epoch: OverlayEpoch): void {
  if (currentEpoch === epoch) currentEpoch = null;
}

export async function openOverlay(
  epoch: OverlayEpoch,
  bounds?: OverlayBounds,
): Promise<boolean> {
  if (!isCurrentOverlay(epoch)) return false;
  await invokeCmd("overlay_open", { epoch, bounds });
  return isCurrentOverlay(epoch);
}

export async function setOverlayBounds(
  epoch: OverlayEpoch,
  bounds: OverlayBounds,
): Promise<void> {
  if (!isCurrentOverlay(epoch)) return;
  await invokeCmd("overlay_set_bounds", { epoch, bounds });
}

/** Close one surface without allowing an older cleanup to close a newer one. */
export async function closeOverlay(epoch: OverlayEpoch | null | undefined): Promise<void> {
  if (epoch == null) return;
  forgetOverlay(epoch);
  await invokeCmd("overlay_close", { epoch });
}

/** Route-level safety net when a room unmount did not get a chance to finish. */
export async function closeCurrentOverlay(): Promise<void> {
  if (currentEpoch != null) {
    forgetOverlay(currentEpoch);
  }
  // Always force-close on leave-room (same rationale as stopCurrentPlayer).
  await invokeCmd("overlay_close", { epoch: null });
}

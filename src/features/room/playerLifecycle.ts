import { invokeCmd } from "@/shared/api/tauri";

/** Native-player session token allocated by Rust. */
export type PlayerEpoch = number;

let currentEpoch: PlayerEpoch | null = null;

/**
 * Starts a logical player session. Rust keeps the matching close tombstone, so
 * an in-flight open/fullscreen transition cannot resurrect mpv after a route
 * cleanup has already run.
 */
export async function beginPlayer(): Promise<PlayerEpoch> {
  const epoch = await invokeCmd<PlayerEpoch>("player_begin");
  if (currentEpoch == null || epoch > currentEpoch) currentEpoch = epoch;
  return epoch;
}

export function isCurrentPlayer(epoch: PlayerEpoch): boolean {
  return currentEpoch === epoch;
}

export function forgetPlayer(epoch: PlayerEpoch): void {
  if (currentEpoch === epoch) currentEpoch = null;
}

/** Close one session without allowing an old room to stop a newer room. */
export async function stopPlayer(epoch: PlayerEpoch | null | undefined): Promise<void> {
  if (epoch == null) return;
  forgetPlayer(epoch);
  await invokeCmd("player_stop", { epoch });
}

/** Route-level safety net for leaving the room hierarchy. */
export async function stopCurrentPlayer(): Promise<void> {
  const epoch = currentEpoch;
  if (epoch != null) {
    forgetPlayer(epoch);
  }
  // Always force-close on the leave-room path. A generation-only stop for a
  // single epoch can no-op when open has not finished activate yet, leaving
  // libmpv decoding after navigation.
  await invokeCmd("player_stop", { epoch: null });
}

import type { PlayUrl, SiteId } from "@/shared/types/live";

const STORAGE_KEY = "rlive-playback-line-preferences";
export const MAX_PLAYBACK_LINE_PREFERENCES = 100;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type PlaybackLinePreference = {
  roomKey: string;
  sourceId: string | null;
  index: number;
  updatedAt: number;
};

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parsePreferences(raw: string | null): PlaybackLinePreference[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is PlaybackLinePreference =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as PlaybackLinePreference).roomKey === "string" &&
          ((entry as PlaybackLinePreference).sourceId === null ||
            typeof (entry as PlaybackLinePreference).sourceId === "string") &&
          Number.isInteger((entry as PlaybackLinePreference).index) &&
          (entry as PlaybackLinePreference).index >= 0 &&
          Number.isFinite((entry as PlaybackLinePreference).updatedAt),
      )
      .slice(0, MAX_PLAYBACK_LINE_PREFERENCES);
  } catch {
    return [];
  }
}

export function playbackLinePreferenceRoomKey(
  siteId: SiteId | undefined,
  roomId: string | undefined,
): string | null {
  const normalizedRoomId = roomId?.trim();
  return siteId && normalizedRoomId ? JSON.stringify([siteId, normalizedRoomId]) : null;
}

export function readPlaybackLinePreference(
  roomKey: string | null,
  storage: StorageLike | null = browserStorage(),
): PlaybackLinePreference | null {
  if (!roomKey || !storage) return null;
  try {
    return (
      parsePreferences(storage.getItem(STORAGE_KEY)).find((entry) => entry.roomKey === roomKey) ??
      null
    );
  } catch {
    return null;
  }
}

export function rememberPlaybackLine(
  roomKey: string | null,
  line: PlayUrl | undefined,
  index: number,
  storage: StorageLike | null = browserStorage(),
  now = Date.now(),
): void {
  if (!roomKey || !line || !storage || !Number.isInteger(index) || index < 0) return;
  const preference: PlaybackLinePreference = {
    roomKey,
    sourceId: line.source_id?.trim() || null,
    index,
    updatedAt: now,
  };
  try {
    const preferences = parsePreferences(storage.getItem(STORAGE_KEY));
    const next = [preference, ...preferences.filter((entry) => entry.roomKey !== roomKey)].slice(
      0,
      MAX_PLAYBACK_LINE_PREFERENCES,
    );
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Playback remains usable when storage is unavailable or full.
  }
}

export function resolvePlaybackLineIndex(
  lines: readonly PlayUrl[],
  preference: PlaybackLinePreference | null,
): number {
  if (lines.length === 0 || !preference) return 0;
  if (preference.sourceId) {
    const sourceIndex = lines.findIndex((line) => line.source_id === preference.sourceId);
    if (sourceIndex >= 0) return sourceIndex;
  }
  return Math.max(0, Math.min(preference.index, lines.length - 1));
}

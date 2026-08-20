export const RECORDING_VIEW_PARAM = "view";

/** The three recording-library scopes the header tabs page between. */
export type RecordingView = "all" | "recording" | "recorded";

export const RECORDING_VIEWS: readonly RecordingView[] = ["all", "recording", "recorded"];

/**
 * The active scope lives in the address bar rather than in page state: the
 * application header owns the tabs while the page owns the lists, and a search
 * param is the one place both can read without either importing the other's
 * state. This mirrors how `/history` shares its timeline switcher.
 */
export function recordingViewFromSearch(value: string | null | undefined): RecordingView {
  return value === "recording" || value === "recorded" ? value : "all";
}

export function withRecordingView(current: URLSearchParams, view: RecordingView): URLSearchParams {
  const next = new URLSearchParams(current);
  if (view === "all") next.delete(RECORDING_VIEW_PARAM);
  else next.set(RECORDING_VIEW_PARAM, view);
  return next;
}

/**
 * Builds the playback path for a recording id.
 *
 * An id is a two-level bundle path (`platform_room/user_timestamp`), and the
 * playback route spends one segment on each level. Encoding the whole id with
 * `encodeURIComponent` instead would turn the separator into `%2F`, which the
 * router hands back only half-decoded and which then matches no library item.
 */
export function recordingPlaybackPath(id: string): string {
  const levels = id.split("/").map(encodeURIComponent).join("/");
  return `/recordings/play/${levels}`;
}

/**
 * Rebuilds the recording id from the playback route params. Returns null when a
 * level is missing, so a hand-typed URL fails to match rather than resolving to
 * a partial id.
 */
export function recordingIdFromPlaybackParams(
  roomDir: string | undefined,
  sessionDir: string | undefined,
): string | null {
  if (!roomDir || !sessionDir) return null;
  try {
    return `${decodeURIComponent(roomDir)}/${decodeURIComponent(sessionDir)}`;
  } catch {
    // A malformed percent-escape cannot name a recording.
    return null;
  }
}

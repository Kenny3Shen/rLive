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

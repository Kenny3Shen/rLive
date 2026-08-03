import { create } from "zustand";
import type { IptvAvailabilityState } from "./availability";

/**
 * Availability results survive route switches inside one session. The IPTV
 * discovery page owns the actual probing (it needs the current playlist), but
 * the per-URL states, progress and the last-run timestamp live here so that
 * leaving /iptv and coming back does not discard a finished detection run.
 *
 * The cache is intentionally not persisted: stream statuses go stale quickly
 * and must never be mistaken for durable facts across app restarts.
 */
export type IptvAvailabilityProgress = {
  completed: number;
  total: number;
};

type AvailabilityEntry = { url: string; state: IptvAvailabilityState };

type IptvAvailabilityStoreState = {
  /** Stream URL → availability state for the last visited source. */
  byUrl: ReadonlyMap<string, IptvAvailabilityState>;
  progress: IptvAvailabilityProgress | null;
  /** Unix ms when the last successful run for this source finished. */
  lastCheckedAt: number | null;
  /** Source URL the cached byUrl/lastCheckedAt describe; mismatch forces a reset. */
  sourceUrl: string | null;
  setAvailability: (url: string, state: IptvAvailabilityState) => void;
  setManyAvailability: (entries: readonly AvailabilityEntry[]) => void;
  setProgress: (progress: IptvAvailabilityProgress | null) => void;
  /** Record a completed run for the given source, guarded so a stale user does not move the clock. */
  markChecked: (sourceUrl: string, at?: number) => void;
  /** Undo "checking" markers after a failed run, restoring previous states or dropping unknown URLs. */
  revertChecking: (
    urls: readonly string[],
    previous: ReadonlyMap<string, IptvAvailabilityState>,
  ) => void;
  /** Reset cached results once a different source becomes the active one. */
  resetForSource: (sourceUrl: string) => void;
  /** Drop the current source results when the user explicitly refreshes it. */
  clearForSource: (sourceUrl: string) => void;
};

export const useIptvAvailabilityStore = create<IptvAvailabilityStoreState>((set) => ({
  byUrl: new Map(),
  progress: null,
  lastCheckedAt: null,
  sourceUrl: null,
  setAvailability: (url, state) =>
    set((current) => {
      const next = new Map(current.byUrl);
      next.set(url, state);
      return { byUrl: next };
    }),
  setManyAvailability: (entries) =>
    set((current) => {
      const next = new Map(current.byUrl);
      for (const entry of entries) {
        next.set(entry.url, entry.state);
      }
      return { byUrl: next };
    }),
  setProgress: (progress) => set({ progress }),
  markChecked: (sourceUrl, at = Date.now()) =>
    set((current) => (current.sourceUrl === sourceUrl ? { lastCheckedAt: at } : current)),
  revertChecking: (urls, previous) =>
    set((current) => {
      const next = new Map(current.byUrl);
      for (const url of urls) {
        if (next.get(url)?.status !== "checking") continue;
        const restored = previous.get(url);
        if (restored) next.set(url, restored);
        else next.delete(url);
      }
      return { byUrl: next, progress: null };
    }),
  resetForSource: (sourceUrl) =>
    set((current) =>
      current.sourceUrl === sourceUrl
        ? current
        : { byUrl: new Map(), progress: null, lastCheckedAt: null, sourceUrl },
    ),
  clearForSource: (sourceUrl) =>
    set({ byUrl: new Map(), progress: null, lastCheckedAt: null, sourceUrl }),
}));

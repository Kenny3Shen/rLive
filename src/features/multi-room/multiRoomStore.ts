import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LiveRoomDetail, LiveRoomItem, SiteId } from "@/shared/types/live";

export const MULTI_ROOM_MAX_SLOTS = 6;
export const MULTI_ROOM_MAIN_SLOT = 0;
export const MULTI_ROOM_LAYOUT_OPTIONS = [4, 6] as const;
export const MULTI_ROOM_FOUR_LAYOUT_OPTIONS = ["main-left", "equal"] as const;

export type MultiRoomLayout = (typeof MULTI_ROOM_LAYOUT_OPTIONS)[number];
export type MultiRoomFourLayout = (typeof MULTI_ROOM_FOUR_LAYOUT_OPTIONS)[number];

const DEFAULT_MULTI_ROOM_LAYOUT: MultiRoomLayout = 6;
const DEFAULT_MULTI_ROOM_FOUR_LAYOUT: MultiRoomFourLayout = "main-left";

export type MultiRoomCandidate = Pick<LiveRoomItem, "site_id" | "room_id"> &
  Partial<Pick<LiveRoomItem, "title" | "cover" | "user_name">>;

export type MultiRoomEntry = {
  key: string;
  siteId: SiteId;
  roomId: string;
  title: string;
  userName: string;
  cover: string;
  volume: number;
  muted: boolean;
};

export type MultiRoomAddResult = "added" | "exists" | "full";

export function normalizeMultiRoomLayout(layout: unknown): MultiRoomLayout {
  return MULTI_ROOM_LAYOUT_OPTIONS.includes(layout as MultiRoomLayout)
    ? (layout as MultiRoomLayout)
    : DEFAULT_MULTI_ROOM_LAYOUT;
}

export function normalizeMultiRoomFourLayout(layout: unknown): MultiRoomFourLayout {
  return MULTI_ROOM_FOUR_LAYOUT_OPTIONS.includes(layout as MultiRoomFourLayout)
    ? (layout as MultiRoomFourLayout)
    : DEFAULT_MULTI_ROOM_FOUR_LAYOUT;
}

export function findMultiRoomEmptySlot(
  slots: readonly (MultiRoomEntry | null)[],
  layout: MultiRoomLayout,
): number {
  return slots.slice(0, layout).findIndex((room) => room == null);
}

export function multiRoomKey(siteId: SiteId, roomId: string): string {
  return `${siteId}\u0000${roomId}`;
}

export function createMultiRoomEntry(
  candidate: MultiRoomCandidate,
  primary: boolean,
): MultiRoomEntry {
  return {
    key: multiRoomKey(candidate.site_id, candidate.room_id),
    siteId: candidate.site_id,
    roomId: candidate.room_id,
    title: candidate.title?.trim() || candidate.user_name?.trim() || "直播间",
    userName: candidate.user_name?.trim() || "未知主播",
    cover: candidate.cover?.trim() || "",
    volume: primary ? 80 : 0,
    muted: !primary,
  };
}

/** Keep exactly the current main feed audible while secondary feeds stay muted. */
export function normalizeMultiRoomAudioRoles(
  slots: readonly (MultiRoomEntry | null)[],
): (MultiRoomEntry | null)[] {
  return slots.map((room, index) => {
    if (!room) return null;
    if (index === MULTI_ROOM_MAIN_SLOT) {
      return {
        ...room,
        volume: room.volume > 0 ? room.volume : 80,
        muted: false,
      };
    }
    return { ...room, muted: true };
  });
}

export function normalizeMultiRoomSlots(
  slots: readonly (MultiRoomEntry | null)[],
): (MultiRoomEntry | null)[] {
  const occupied: MultiRoomEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < MULTI_ROOM_MAX_SLOTS; index += 1) {
    const room = slots[index];
    if (!room || seen.has(room.key)) continue;
    seen.add(room.key);
    occupied.push(stripLegacySecondarySlot(room));
  }

  const next = Array.from<MultiRoomEntry | null>({ length: MULTI_ROOM_MAX_SLOTS }).fill(null);
  occupied.forEach((room, index) => {
    next[index] = room;
  });
  return next;
}

type LegacyMultiRoomEntry = MultiRoomEntry & { secondarySlot?: number | null };

function stripLegacySecondarySlot(room: MultiRoomEntry): MultiRoomEntry {
  const { secondarySlot: _secondarySlot, ...entry } = room as LegacyMultiRoomEntry;
  return entry;
}

/** Swap one occupied secondary slot with the main slot. */
export function swapMultiRoomMain(
  slots: readonly (MultiRoomEntry | null)[],
  sourceIndex: number,
): (MultiRoomEntry | null)[] {
  const next = normalizeMultiRoomSlots(slots);
  if (
    sourceIndex <= MULTI_ROOM_MAIN_SLOT ||
    sourceIndex >= MULTI_ROOM_MAX_SLOTS ||
    !next[sourceIndex] ||
    !next[MULTI_ROOM_MAIN_SLOT]
  ) {
    return next;
  }

  [next[MULTI_ROOM_MAIN_SLOT], next[sourceIndex]] = [next[sourceIndex], next[MULTI_ROOM_MAIN_SLOT]];
  return next;
}

type MultiRoomState = {
  slots: (MultiRoomEntry | null)[];
  layout: MultiRoomLayout;
  fourLayout: MultiRoomFourLayout;
  addRoom: (candidate: MultiRoomCandidate) => MultiRoomAddResult;
  removeRoom: (key: string) => void;
  setMainRoom: (key: string) => void;
  updateAudio: (key: string, volume: number, muted: boolean) => void;
  updateMetadata: (key: string, detail: LiveRoomDetail) => void;
  setLayout: (layout: MultiRoomLayout) => boolean;
  setFourLayout: (layout: MultiRoomFourLayout) => void;
  clear: () => void;
};

const EMPTY_MULTI_ROOM_SLOTS = Array.from<MultiRoomEntry | null>({
  length: MULTI_ROOM_MAX_SLOTS,
}).fill(null);

export const useMultiRoomStore = create<MultiRoomState>()(
  persist(
    (set, get) => ({
      slots: [...EMPTY_MULTI_ROOM_SLOTS],
      layout: DEFAULT_MULTI_ROOM_LAYOUT,
      fourLayout: DEFAULT_MULTI_ROOM_FOUR_LAYOUT,
      addRoom: (candidate) => {
        const slots = normalizeMultiRoomSlots(get().slots);
        const layout = normalizeMultiRoomLayout(get().layout);
        const key = multiRoomKey(candidate.site_id, candidate.room_id);
        if (slots.some((room) => room?.key === key)) return "exists";
        const targetIndex = findMultiRoomEmptySlot(slots, layout);
        if (targetIndex < 0) return "full";
        slots[targetIndex] = createMultiRoomEntry(candidate, targetIndex === MULTI_ROOM_MAIN_SLOT);
        set({ slots });
        return "added";
      },
      removeRoom: (key) => {
        const slots = normalizeMultiRoomSlots(get().slots);
        const index = slots.findIndex((room) => room?.key === key);
        if (index < 0) return;
        slots[index] = null;
        const next = normalizeMultiRoomSlots(slots);
        set({ slots: index === MULTI_ROOM_MAIN_SLOT ? normalizeMultiRoomAudioRoles(next) : next });
      },
      setMainRoom: (key) => {
        const slots = normalizeMultiRoomSlots(get().slots);
        const sourceIndex = slots.findIndex((room) => room?.key === key);
        if (sourceIndex <= MULTI_ROOM_MAIN_SLOT) return;
        set({
          slots: normalizeMultiRoomAudioRoles(swapMultiRoomMain(slots, sourceIndex)),
        });
      },
      updateAudio: (key, volume, muted) => {
        const normalizedVolume = Math.max(0, Math.min(100, Math.round(volume)));
        set({
          slots: get().slots.map((room) =>
            room?.key === key
              ? { ...room, volume: normalizedVolume, muted: muted || normalizedVolume === 0 }
              : room,
          ),
        });
      },
      updateMetadata: (key, detail) => {
        set({
          slots: get().slots.map((room) =>
            room?.key === key
              ? {
                  ...room,
                  title: detail.title || room.title,
                  userName: detail.user_name || room.userName,
                  cover: detail.cover || room.cover,
                }
              : room,
          ),
        });
      },
      setLayout: (layout) => {
        const normalizedLayout = normalizeMultiRoomLayout(layout);
        if (normalizedLayout === get().layout) return true;
        if (get().slots.filter(Boolean).length > normalizedLayout) return false;
        set({ layout: normalizedLayout });
        return true;
      },
      setFourLayout: (layout) => set({ fourLayout: normalizeMultiRoomFourLayout(layout) }),
      clear: () => set({ slots: [...EMPTY_MULTI_ROOM_SLOTS] }),
    }),
    {
      name: "rlive-multi-room",
      version: 4,
      migrate: (persistedState) => {
        const state = persistedState as Partial<
          Pick<MultiRoomState, "slots" | "layout" | "fourLayout">
        >;
        return {
          slots: (state.slots ?? []).map((room) => (room ? stripLegacySecondarySlot(room) : null)),
          layout: normalizeMultiRoomLayout(state.layout),
          fourLayout: normalizeMultiRoomFourLayout(state.fourLayout),
        };
      },
      partialize: (state) => ({
        slots: state.slots,
        layout: state.layout,
        fourLayout: state.fourLayout,
      }),
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<MultiRoomState>;
        const requestedLayout = normalizeMultiRoomLayout(persistedState?.layout);
        const fourLayout = normalizeMultiRoomFourLayout(persistedState?.fourLayout);
        const slots = normalizeMultiRoomSlots(
          (persistedState?.slots ?? []).map((room) =>
            room ? stripLegacySecondarySlot(room) : null,
          ),
        );
        return {
          ...current,
          layout:
            slots.filter(Boolean).length <= requestedLayout
              ? requestedLayout
              : DEFAULT_MULTI_ROOM_LAYOUT,
          fourLayout,
          slots,
        };
      },
    },
  ),
);

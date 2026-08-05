import { create } from "zustand";

export type HistoryTab = "watch" | "danmaku";

type HistoryShellControls = {
  activeTab: HistoryTab;
  canClear: boolean;
  clearPending: boolean;
  clearError: boolean;
  clearTitle: string;
  clearDescription: string;
  resetActiveMutation: () => void;
  clearActiveHistory: () => void;
};

type HistoryShellState = HistoryShellControls & {
  clearOpen: boolean;
  registrationId: number | null;
  setActiveTab: (tab: HistoryTab) => void;
  setClearOpen: (open: boolean) => void;
  register: (registrationId: number, controls: HistoryShellControls) => void;
  reset: (registrationId?: number) => void;
};

const initialControls: HistoryShellControls = {
  activeTab: "watch" as HistoryTab,
  canClear: false,
  clearPending: false,
  clearError: false,
  clearTitle: "清空观看历史？",
  clearDescription: "将删除全部观看记录，此操作无法恢复。",
  resetActiveMutation: () => {},
  clearActiveHistory: () => {},
};

let nextRegistrationId = 0;

/** A newer mounted history page always owns the persistent Shell controls. */
export function createHistoryShellRegistrationId(): number {
  nextRegistrationId += 1;
  return nextRegistrationId;
}

export const useHistoryShellStore = create<HistoryShellState>((set) => ({
  ...initialControls,
  clearOpen: false,
  registrationId: null,
  setActiveTab: (activeTab) => set({ activeTab }),
  setClearOpen: (clearOpen) => set({ clearOpen }),
  register: (registrationId, controls) =>
    set((current) => {
      // PagePan retains the outgoing platform until its animation completes.
      // Its query/effect may finish late, but it must never reclaim controls
      // already registered by the newer incoming page.
      if (current.registrationId !== null && current.registrationId > registrationId) {
        return current;
      }
      return { ...controls, registrationId };
    }),
  reset: (registrationId) =>
    set((current) => {
      if (registrationId !== undefined && current.registrationId !== registrationId) {
        return current;
      }
      return { ...initialControls, clearOpen: false, registrationId: null };
    }),
}));

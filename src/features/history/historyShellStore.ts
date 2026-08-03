import { create } from "zustand";

export type HistoryTab = "watch" | "danmaku";

type HistoryShellState = {
  activeTab: HistoryTab;
  canClear: boolean;
  clearPending: boolean;
  clearError: boolean;
  clearOpen: boolean;
  clearTitle: string;
  clearDescription: string;
  setActiveTab: (tab: HistoryTab) => void;
  setClearOpen: (open: boolean) => void;
  resetActiveMutation: () => void;
  clearActiveHistory: () => void;
  register: (state: Partial<HistoryShellState>) => void;
  reset: () => void;
};

const initialState = {
  activeTab: "watch" as HistoryTab,
  canClear: false,
  clearPending: false,
  clearError: false,
  clearOpen: false,
  clearTitle: "清空观看历史？",
  clearDescription: "将删除全部观看记录，此操作无法恢复。",
};

export const useHistoryShellStore = create<HistoryShellState>((set) => ({
  ...initialState,
  setActiveTab: (activeTab) => set({ activeTab }),
  setClearOpen: (clearOpen) => set({ clearOpen }),
  resetActiveMutation: () => {},
  clearActiveHistory: () => {},
  register: (state) => set(state),
  reset: () => set(initialState),
}));

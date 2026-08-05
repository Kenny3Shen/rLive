import { beforeEach, describe, expect, test } from "bun:test";
import {
  createHistoryShellRegistrationId,
  useHistoryShellStore,
} from "../src/features/history/historyShellStore";

function controls(label: string, clearActiveHistory: () => void) {
  return {
    activeTab: "watch" as const,
    canClear: true,
    clearPending: false,
    clearError: false,
    clearTitle: label,
    clearDescription: `${label} description`,
    resetActiveMutation: () => {},
    clearActiveHistory,
  };
}

describe("history Shell control ownership", () => {
  beforeEach(() => {
    useHistoryShellStore.getState().reset();
  });

  test("an outgoing platform cannot reset or reclaim the incoming controls", () => {
    const calls: string[] = [];
    const outgoingId = createHistoryShellRegistrationId();
    const incomingId = createHistoryShellRegistrationId();

    useHistoryShellStore.getState().register(
      outgoingId,
      controls("outgoing", () => calls.push("outgoing")),
    );
    useHistoryShellStore.getState().register(
      incomingId,
      controls("incoming", () => calls.push("incoming")),
    );

    useHistoryShellStore.getState().reset(outgoingId);
    useHistoryShellStore.getState().register(
      outgoingId,
      controls("late outgoing", () => calls.push("late outgoing")),
    );
    useHistoryShellStore.getState().clearActiveHistory();

    expect(useHistoryShellStore.getState().clearTitle).toBe("incoming");
    expect(useHistoryShellStore.getState().canClear).toBe(true);
    expect(calls).toEqual(["incoming"]);
  });

  test("the active page resets its controls when it unmounts", () => {
    const registrationId = createHistoryShellRegistrationId();
    useHistoryShellStore.getState().register(
      registrationId,
      controls("active", () => {}),
    );
    useHistoryShellStore.getState().setClearOpen(true);

    useHistoryShellStore.getState().register(
      registrationId,
      controls("updated", () => {}),
    );
    expect(useHistoryShellStore.getState().clearOpen).toBe(true);

    useHistoryShellStore.getState().reset(registrationId);

    expect(useHistoryShellStore.getState().registrationId).toBeNull();
    expect(useHistoryShellStore.getState().canClear).toBe(false);
    expect(useHistoryShellStore.getState().clearOpen).toBe(false);
  });
});

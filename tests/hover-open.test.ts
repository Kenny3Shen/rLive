import { describe, expect, test } from "bun:test";
import { ignoresTriggerPressClose } from "../src/components/videojs/lib/use-hover-open";

describe("ignoresTriggerPressClose", () => {
  const pointerClick = { type: "click", detail: 1 };
  const keyboardClick = { type: "click", detail: 0 };

  test("swallows a real pointer click on a hover-capable trigger", () => {
    expect(ignoresTriggerPressClose(false, { reason: "click", event: pointerClick }, true)).toBe(
      true,
    );
    expect(
      ignoresTriggerPressClose(false, { reason: "trigger-press", event: pointerClick }, true),
    ).toBe(true);
  });

  test("lets touch, keyboard, Esc, and item selection still close", () => {
    expect(ignoresTriggerPressClose(false, { reason: "click", event: pointerClick }, false)).toBe(
      false,
    );
    expect(ignoresTriggerPressClose(false, { reason: "click", event: keyboardClick }, true)).toBe(
      false,
    );
    expect(
      ignoresTriggerPressClose(false, { reason: "escape", event: { type: "keydown" } }, true),
    ).toBe(false);
    expect(ignoresTriggerPressClose(false, { reason: "click" }, true)).toBe(false);
    expect(ignoresTriggerPressClose(true, { reason: "click", event: pointerClick }, true)).toBe(
      false,
    );
  });
});

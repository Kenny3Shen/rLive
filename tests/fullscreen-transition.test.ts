import { describe, expect, test } from "bun:test";
import {
  beginFullscreenTransition,
  frozenSafeAreaTopValue,
  shouldFreezeFullscreenInsets,
  FULLSCREEN_TRANSITION_ATTRIBUTE,
  FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY,
  FULLSCREEN_TRANSITION_TIMEOUT_MS,
  type FullscreenTransitionRoot,
} from "../src/shared/fullscreenTransition";

function fakeRoot(): {
  root: FullscreenTransitionRoot;
  attributes: Record<string, string>;
  properties: Record<string, string>;
} {
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const root: FullscreenTransitionRoot = {
    style: {
      setProperty(name, value) {
        properties[name] = value;
      },
      removeProperty(name) {
        delete properties[name];
      },
    },
    setAttribute(name, value) {
      attributes[name] = value;
    },
    removeAttribute(name) {
      delete attributes[name];
    },
  };
  return { root, attributes, properties };
}

describe("fullscreen inset freeze", () => {
  test("only the inset-driven mobile shell needs the freeze", () => {
    // 桌面切换为原生窗口全屏且不带安全区内边距，因此没有可钉住的东西。
    expect(shouldFreezeFullscreenInsets("desktop")).toBe(false);
    expect(shouldFreezeFullscreenInsets("android")).toBe(true);
    expect(shouldFreezeFullscreenInsets("ios")).toBe(true);
    expect(shouldFreezeFullscreenInsets("web")).toBe(true);
  });

  test("pins the padding the shell already had and restores it on release", () => {
    const { root, attributes, properties } = fakeRoot();

    const release = beginFullscreenTransition(root, "41.5px");

    expect(attributes[FULLSCREEN_TRANSITION_ATTRIBUTE]).toBe("true");
    expect(properties[FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY]).toBe("41.5px");

    release();

    expect(attributes[FULLSCREEN_TRANSITION_ATTRIBUTE]).toBeUndefined();
    expect(properties[FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY]).toBeUndefined();
  });

  test("release is idempotent so the first of event/refusal/timeout wins", () => {
    const { root, attributes } = fakeRoot();
    const release = beginFullscreenTransition(root, "24px");

    release();
    // 迟到的超时不得清除更新一次过渡安装的冻结。
    root.setAttribute(FULLSCREEN_TRANSITION_ATTRIBUTE, "true");
    release();

    expect(attributes[FULLSCREEN_TRANSITION_ATTRIBUTE]).toBe("true");
  });

  test("skips the freeze when there is no padding to hold still", () => {
    const { root, attributes, properties } = fakeRoot();

    // 为零的 inset 钉不住任何东西，但仍会抑制之后的变更。
    beginFullscreenTransition(root, frozenSafeAreaTopValue("0px"));
    beginFullscreenTransition(root, frozenSafeAreaTopValue(""));
    beginFullscreenTransition(root, frozenSafeAreaTopValue(null));

    expect(attributes[FULLSCREEN_TRANSITION_ATTRIBUTE]).toBeUndefined();
    expect(properties[FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY]).toBeUndefined();
  });

  test("reads a usable padding value and rejects an unusable one", () => {
    expect(frozenSafeAreaTopValue("41.5px")).toBe("41.5px");
    expect(frozenSafeAreaTopValue("  24px  ")).toBe("24px");
    expect(frozenSafeAreaTopValue("0px")).toBeNull();
    expect(frozenSafeAreaTopValue("auto")).toBeNull();
    expect(frozenSafeAreaTopValue("")).toBeNull();
    expect(frozenSafeAreaTopValue(null)).toBeNull();
    expect(frozenSafeAreaTopValue(undefined)).toBeNull();
  });

  test("a missing root degrades to a no-op release", () => {
    expect(() => beginFullscreenTransition(null, "24px")()).not.toThrow();
    expect(() => beginFullscreenTransition(undefined, "24px")()).not.toThrow();
  });

  test("the backstop outlasts a system-bar animation without stranding the freeze", () => {
    expect(FULLSCREEN_TRANSITION_TIMEOUT_MS).toBeGreaterThan(600);
    expect(FULLSCREEN_TRANSITION_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });
});

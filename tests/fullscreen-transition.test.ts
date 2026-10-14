import { describe, expect, test } from "bun:test";
import {
  beginFullscreenTransition,
  frozenSafeAreaTopValue,
  FULLSCREEN_TRANSITION_ATTRIBUTE,
  FULLSCREEN_TRANSITION_SAFE_AREA_TOP_PROPERTY,
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
  return {
    root,
    attributes,
    properties,
  };
}
describe("fullscreen inset freeze", () => {
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
});

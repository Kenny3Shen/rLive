import { describe, expect, test } from "bun:test";
import {
  KEYBOARD_NAV_ATTRIBUTE,
  type KeyboardNavigationEvent,
  type KeyboardNavigationListener,
  watchKeyboardNavigation,
} from "../src/shared/keyboardNavigation";

/** 只记属性状态，够 CSS 侧那条 `:root[data-keyboard-nav]` 判定用。 */
function fakeRoot() {
  const attributes = new Set<string>();
  return {
    setAttribute(name: string) {
      attributes.add(name);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    get marked() {
      return attributes.has(KEYBOARD_NAV_ATTRIBUTE);
    },
  };
}

/** 记录注册情况，使解绑与捕获阶段都可断言。 */
function fakeTarget() {
  const listeners = new Map<string, Set<KeyboardNavigationListener>>();
  const captureFlags: boolean[] = [];
  return {
    addEventListener(
      type: string,
      listener: KeyboardNavigationListener,
      options?: {
        capture?: boolean;
      },
    ) {
      captureFlags.push(options?.capture === true);
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: KeyboardNavigationListener) {
      listeners.get(type)?.delete(listener);
    },
    emit(event: KeyboardNavigationEvent) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
    get allCapture() {
      return captureFlags.length > 0 && captureFlags.every(Boolean);
    },
  };
}
const keyDown = (key: string, target?: unknown): KeyboardNavigationEvent => ({
  type: "keydown",
  key,
  target,
});
const pointerDown: KeyboardNavigationEvent = {
  type: "pointerdown",
};
const textInput = {
  tagName: "INPUT",
  type: "text",
};
describe("keyboard navigation gate", () => {
  test("导航按键挂标记，指针按下立即抹除", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    watchKeyboardNavigation({
      root,
      target,
    });
    expect(root.marked).toBe(false);
    target.emit(keyDown("Tab"));
    expect(root.marked).toBe(true);
    target.emit(pointerDown);
    expect(root.marked).toBe(false);
  });
  test("两个监听都在捕获阶段，解绑后不再响应", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    const stop = watchKeyboardNavigation({
      root,
      target,
    });
    expect(target.allCapture).toBe(true);
    expect(target.count("keydown")).toBe(1);
    expect(target.count("pointerdown")).toBe(1);
    stop();
    expect(target.count("keydown")).toBe(0);
    expect(target.count("pointerdown")).toBe(0);
    target.emit(keyDown("Tab"));
    expect(root.marked).toBe(false);
  });
  test("文本框里的方向键只移动光标，不算导航", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    watchKeyboardNavigation({
      root,
      target,
    });
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      target.emit(keyDown(key, textInput));
      expect(root.marked).toBe(false);
    }
    // Tab 例外：它一定把焦点移出输入框。
    target.emit(keyDown("Tab", textInput));
    expect(root.marked).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import {
  isNavigationKey,
  isTextEntryTarget,
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
      options?: { capture?: boolean },
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
const pointerDown: KeyboardNavigationEvent = { type: "pointerdown" };

const textInput = { tagName: "INPUT", type: "text" };

describe("keyboard navigation gate", () => {
  test("只有移动焦点的按键算导航", () => {
    for (const key of ["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(isNavigationKey(key)).toBe(true);
    }
    // 激活、输入与退出都不是导航：Escape 退出全屏后焦点会回到刚点过的按钮，
    // 若算作导航就正好把要修的描边带回来。
    for (const key of ["Enter", " ", "a", "Escape", "F11"]) {
      expect(isNavigationKey(key)).toBe(false);
    }
  });

  test("导航按键挂标记，指针按下立即抹除", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    watchKeyboardNavigation({ root, target });

    expect(root.marked).toBe(false);
    target.emit(keyDown("Tab"));
    expect(root.marked).toBe(true);
    target.emit(pointerDown);
    expect(root.marked).toBe(false);
  });

  test("字符输入不会把标记挂上", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    watchKeyboardNavigation({ root, target });

    target.emit(keyDown("a"));
    target.emit(keyDown("Enter"));
    expect(root.marked).toBe(false);
  });

  test("点击全屏再侧滑返回：标记早在点击时就没了", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    watchKeyboardNavigation({ root, target });

    // 先键盘导航到按钮。
    target.emit(keyDown("Tab"));
    expect(root.marked).toBe(true);
    // 改用触摸点全屏 —— pointerdown 抹除标记。
    target.emit(pointerDown);
    // 侧滑返回把焦点交还给该按钮（程序化聚焦，不产生按键事件）。
    expect(root.marked).toBe(false);
  });

  test("按键事件缺少 key 时不误判", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    watchKeyboardNavigation({ root, target });

    target.emit({ type: "keydown" });
    expect(root.marked).toBe(false);
  });

  test("两个监听都在捕获阶段，解绑后不再响应", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    const stop = watchKeyboardNavigation({ root, target });

    expect(target.allCapture).toBe(true);
    expect(target.count("keydown")).toBe(1);
    expect(target.count("pointerdown")).toBe(1);

    stop();
    expect(target.count("keydown")).toBe(0);
    expect(target.count("pointerdown")).toBe(0);

    target.emit(keyDown("Tab"));
    expect(root.marked).toBe(false);
  });

  test("识别带光标的文本框", () => {
    expect(isTextEntryTarget(textInput)).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT" })).toBe(true); // 省略 type 即 text
    expect(isTextEntryTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntryTarget({ isContentEditable: true })).toBe(true);
    // 这些控件里方向键改的是取值或选中项，属于真实的键盘操作。
    expect(isTextEntryTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget(undefined)).toBe(false);
  });

  test("文本框里的方向键只移动光标，不算导航", () => {
    const root = fakeRoot();
    const target = fakeTarget();
    watchKeyboardNavigation({ root, target });

    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      target.emit(keyDown(key, textInput));
      expect(root.marked).toBe(false);
    }
    // Tab 例外：它一定把焦点移出输入框。
    target.emit(keyDown("Tab", textInput));
    expect(root.marked).toBe(true);
  });

  test("没有 target 或 root 时安全退化", () => {
    expect(() => watchKeyboardNavigation({ root: undefined, target: undefined })()).not.toThrow();
  });
});

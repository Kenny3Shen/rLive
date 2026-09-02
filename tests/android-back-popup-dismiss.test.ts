import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

// bun 的测试环境没有 DOM 构造器。返回键只需要一个带 key 的合成事件，
// 这里补一个最小替身，让 dismissTopmostPopup 能在无 DOM 下被验证。
class KeyboardEventStub extends Event {
  key: string;
  constructor(type: string, init: { key: string; bubbles?: boolean }) {
    super(type, { bubbles: init.bubbles });
    this.key = init.key;
  }
}(globalThis as unknown as { KeyboardEvent: typeof KeyboardEventStub }).KeyboardEvent =
  KeyboardEventStub;

const { DISMISSIBLE_POPUP_SELECTOR, dismissTopmostPopup } = await import(
  "../src/app/androidBackNavigation"
);

/** 只实现 dismissTopmostPopup 用到的两个方法。 */
function fakeDocument(hasOpenPopup: boolean) {
  const dispatched: Event[] = [];
  let querySelectorArg: string | null = null;
  const doc = {
    querySelector(selector: string) {
      querySelectorArg = selector;
      return hasOpenPopup ? {} : null;
    },
    dispatchEvent(event: Event) {
      dispatched.push(event);
      return true;
    },
  } as unknown as Document;
  return { doc, dispatched, selectorOf: () => querySelectorArg };
}

describe("Android Back 先关闭弹窗", () => {
  test("展开的弹窗消费这一次 Back 并收到合成 Escape", () => {
    const { doc, dispatched } = fakeDocument(true);
    expect(dismissTopmostPopup(doc)).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe("keydown");
    expect((dispatched[0] as KeyboardEventStub).key).toBe("Escape");
    // 不得冒泡：房间页在 window 上报了冒泡阶段的 Escape 监听器（全屏退出、
    // 网页全屏退出、侧边抽屉），冒泡的合成事件会让一次 Back 多退一层。
    expect(dispatched[0]!.bubbles).toBe(false);
  });

  test("没有弹窗时不消费 Back，也不派发按键", () => {
    const { doc, dispatched } = fakeDocument(false);
    expect(dismissTopmostPopup(doc)).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  test("只命中真正展开的表面：退场动画期间是 data-closed", () => {
    const { doc, selectorOf } = fakeDocument(false);
    dismissTopmostPopup(doc);
    const selector = selectorOf()!;
    expect(selector).toBe(DISMISSIBLE_POPUP_SELECTOR);
    // 每个分支都要求 data-open；漏掉它会让退场中的弹窗白吃一次 Back。
    for (const branch of selector.split(",")) {
      expect(branch).toContain("[data-open]");
    }
  });

  test("每个 base-ui Popup 包装都被选择器覆盖", () => {
    // 选择器是按 data-slot 硬编码的，新增一个浮层原语却忘记登记时，
    // 那个弹窗会静悄悄地退回上一级页面。这里从 UI 包装层反向核对。
    const uiDirectory = new URL("../src/components/ui/", import.meta.url);
    const popupSlots = new Set<string>();
    for (const file of readdirSync(uiDirectory)) {
      if (!file.endsWith(".tsx")) continue;
      const source = readFileSync(new URL(file, uiDirectory), "utf8");
      // 形如 `<XPrimitive.Popup\n  data-slot="x-content"`：取紧随其后的 data-slot。
      for (const match of source.matchAll(
        /<\w+Primitive\.Popup\b[^>]*?data-slot="([^"]+)"/gs,
      )) {
        popupSlots.add(match[1]!);
      }
    }

    expect(popupSlots.size).toBeGreaterThan(0);
    const covered = new Set(
      DISMISSIBLE_POPUP_SELECTOR.split(",").map(
        (branch) => branch.match(/data-slot="([^"]+)"/)![1]!,
      ),
    );
    const uncovered = [...popupSlots].filter((slot) => !covered.has(slot));
    // tooltip 是唯一刻意排除的：它不是用户显式打开的表面。
    expect(uncovered).toEqual(["tooltip-content"]);
  });
});

import { describe, expect, test } from "bun:test";
import { applyPlayerChromeVisibility } from "../src/shared/hooks/usePlayerChromeVisibility";

function elementFixture() {
  const attributes = new Map<string, string>();
  const element = {
    dataset: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    toggleAttribute(name: string, enabled: boolean) {
      if (enabled) attributes.set(name, "");
      else attributes.delete(name);
    },
  };
  return { element: element as unknown as HTMLElement, attributes };
}

describe("播放器命令式显隐", () => {
  test("隐藏时同时关闭可见性、辅助技术暴露和焦点交互", () => {
    const controls = elementFixture();
    const hud = elementFixture();
    applyPlayerChromeVisibility([controls.element, hud.element], false);
    for (const fixture of [controls, hud]) {
      expect(fixture.element.dataset.visible).toBe("false");
      expect(fixture.attributes.get("aria-hidden")).toBe("true");
      expect(fixture.attributes.has("inert")).toBe(true);
    }
  });

  test("重新显示时恢复可访问性并移除 inert", () => {
    const { element, attributes } = elementFixture();
    applyPlayerChromeVisibility([element], false);
    applyPlayerChromeVisibility([element], true);
    expect(element.dataset.visible).toBe("true");
    expect(attributes.get("aria-hidden")).toBe("false");
    expect(attributes.has("inert")).toBe(false);
  });

  test("允许 HUD 或全屏锁定层尚未挂载", () => {
    const { element, attributes } = elementFixture();
    applyPlayerChromeVisibility([null, element, undefined], false);
    expect(element.dataset.visible).toBe("false");
    expect(attributes.has("inert")).toBe(true);
  });
});

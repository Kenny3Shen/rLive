import { describe, expect, test } from "bun:test";
import { createAsrCaptionTextStore } from "../src/features/asr/asrCaptionText";

describe("语音字幕文本 store", () => {
  test("内容不变时不通知，快照引用保持不变", () => {
    const store = createAsrCaptionTextStore();
    const initial = store.get();
    let calls = 0;
    store.subscribe(() => calls++);
    // 每个识别窗都会写一次「无在途假设」，不应触发叠加层重渲染。
    store.update({ partial: null });
    store.update({ caption: null, translatedCaption: null });
    expect(calls).toBe(0);
    expect(store.get()).toBe(initial);
  });

  test("局部更新只改指定字段，并生成新快照", () => {
    const store = createAsrCaptionTextStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.update({ caption: "你好。", partial: "世" });
    const first = store.get();
    expect(first).toEqual({
      caption: "你好。",
      partial: "世",
      translatedCaption: null,
      translationNotice: null,
    });
    store.update({ translatedCaption: "Hello." });
    expect(store.get()).not.toBe(first);
    expect(store.get().caption).toBe("你好。");
    expect(store.get().translatedCaption).toBe("Hello.");
    expect(calls).toBe(2);
  });

  test("函数式更新读取当前快照", () => {
    const store = createAsrCaptionTextStore();
    store.update({ caption: "第一句。" });
    store.update((current) => ({ caption: `${current.caption}\n第二句。` }));
    expect(store.get().caption).toBe("第一句。\n第二句。");
  });

  test("退订后不再通知", () => {
    const store = createAsrCaptionTextStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.update({ partial: "a" });
    off();
    store.update({ partial: "b" });
    expect(calls).toBe(1);
  });
});

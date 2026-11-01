import { describe, expect, test } from "bun:test";
import {
  createAsrTranscriptStore,
  type AsrTranscriptChange,
} from "../src/features/asr/asrTranscript";

describe("独立字幕转录 store", () => {
  test("首次追加与换房间插入分隔条，同一房间换清晰度不插入", () => {
    const store = createAsrTranscriptStore();
    const first = store.appendLine({
      text: "第一句。",
      sourceKey: "room-A",
      sourceTitle: "房间 A",
      at: 1_000,
    });
    store.appendLine({
      text: "第二句。",
      sourceKey: "room-A",
      sourceTitle: "房间 A",
      at: 2_000,
    });

    expect(store.getEntries().map((entry) => entry.kind)).toEqual(["divider", "line", "line"]);
    expect(store.getEntries()[0]).toMatchObject({
      kind: "divider",
      title: "房间 A",
      at: 1_000,
    });
    expect(first.translation).toBeNull();

    const third = store.appendLine({
      text: "第三句。",
      sourceKey: "room-B",
      sourceTitle: "房间 B",
      at: 3_000,
    });

    expect(store.getEntries().map((entry) => entry.kind)).toEqual([
      "divider",
      "line",
      "line",
      "divider",
      "line",
    ]);
    expect(store.getEntries().at(-2)).toMatchObject({
      kind: "divider",
      title: "房间 B",
    });
    expect(store.getEntries().at(-1)?.id).toBe(third.id);
  });

  test("按条目 id 回填译文，重复或未知 id 不产生变更", () => {
    const store = createAsrTranscriptStore();
    const line = store.appendLine({
      text: "你好。",
      sourceKey: "room-A",
      sourceTitle: "房间 A",
    });
    const changes: AsrTranscriptChange[] = [];
    store.subscribe((change) => changes.push(change));

    store.patchTranslation(line.id, "Hello.");
    store.patchTranslation(line.id, "Hello.");
    store.patchTranslation("missing-line", "ignored");

    expect(store.getEntries().at(-1)).toMatchObject({
      kind: "line",
      id: line.id,
      translation: "Hello.",
    });
    expect(changes).toEqual([{ kind: "patch", id: line.id, translation: "Hello." }]);
  });

  test("译文按 id 定位到正确条目，已取出的快照不随后续写入变化", () => {
    const store = createAsrTranscriptStore();
    store.appendLine({ text: "第一句。", sourceKey: "room-A", sourceTitle: "房间 A" });
    const second = store.appendLine({
      text: "第二句。",
      sourceKey: "room-A",
      sourceTitle: "房间 A",
    });
    store.appendLine({ text: "第三句。", sourceKey: "room-A", sourceTitle: "房间 A" });

    // 快照在回填与追加之前取出，必须保持原样。
    const snapshot = store.getEntries();
    store.patchTranslation(second.id, "第二句译文。");
    store.appendLine({ text: "第四句。", sourceKey: "room-A", sourceTitle: "房间 A" });

    expect(
      store.getEntries().map((entry) => (entry.kind === "line" ? entry.translation : null)),
    ).toEqual([null, null, "第二句译文。", null, null]);
    expect(snapshot).toHaveLength(4);
    expect(snapshot.map((entry) => (entry.kind === "line" ? entry.translation : null))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("追加、译文与实时状态都以增量通知，不发送整份快照", () => {
    const store = createAsrTranscriptStore();
    const changes: AsrTranscriptChange[] = [];
    store.subscribe((change) => changes.push(change));

    store.appendLine({
      text: "第一句。",
      sourceKey: "room-A",
      sourceTitle: "房间 A",
    });
    // 新房间先发分隔条，再发语句本身。
    expect(changes.map((change) => change.kind)).toEqual(["append", "append"]);

    store.appendLine({
      text: "第二句。",
      sourceKey: "room-A",
      sourceTitle: "房间 A",
    });
    expect(changes.map((change) => change.kind)).toEqual(["append", "append", "append"]);

    store.updateLive({ sourceTitle: "房间 A", captionsOn: true, partial: "在途" });
    const liveChange = changes.at(-1);
    expect(liveChange).toMatchObject({
      kind: "live",
      live: { sourceTitle: "房间 A", captionsOn: true, partial: "在途" },
    });

    // 相同内容不重复通知；每个识别窗都会写一次相同的在途文本。
    store.updateLive({ sourceTitle: "房间 A", captionsOn: true, partial: "在途" });
    expect(changes).toHaveLength(4);

    store.updateLive({ partial: null });
    expect(changes).toHaveLength(5);
    expect(store.getLive().partial).toBeNull();
  });

  test("保留本次运行的全部对话，不设条目上限", () => {
    const store = createAsrTranscriptStore();
    for (let index = 0; index < 200; index += 1) {
      store.appendLine({
        text: `第 ${index} 句。`,
        sourceKey: "room-A",
        sourceTitle: "房间 A",
      });
    }

    expect(store.getEntries()).toHaveLength(201);
    expect(store.getEntries().at(-1)).toMatchObject({
      kind: "line",
      text: "第 199 句。",
    });
  });

  test("清空历史后保留实时状态，下一句重新插入分隔条，迟到译文被丢弃", () => {
    const store = createAsrTranscriptStore();
    const line = store.appendLine({ text: "第一句。", sourceKey: "room-A", sourceTitle: "房间 A" });
    store.updateLive({ captionsOn: true, partial: "在途" });
    const changes: AsrTranscriptChange[] = [];
    store.subscribe((change) => changes.push(change));

    store.clear();
    expect(store.getEntries()).toEqual([]);
    expect(store.getLive()).toMatchObject({ captionsOn: true, partial: "在途" });
    expect(changes).toEqual([{ kind: "clear" }]);

    // 空记录再清空不重复通知。
    store.clear();
    expect(changes).toHaveLength(1);

    store.patchTranslation(line.id, "First line.");
    expect(changes).toHaveLength(1);

    store.appendLine({ text: "第二句。", sourceKey: "room-A", sourceTitle: "房间 A" });
    expect(store.getEntries().map((entry) => entry.kind)).toEqual(["divider", "line"]);
  });
});

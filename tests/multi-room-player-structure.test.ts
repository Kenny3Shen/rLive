import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(file: string): string {
  return readFileSync(join(import.meta.dir, "..", file), "utf8");
}

const playerSource = source("src/features/multi-room/MultiRoomPlayer.tsx");

describe("多画面角色切换的播放器结构", () => {
  test("主副角色切换始终保持同一 ASR provider 父链", () => {
    expect(playerSource).not.toMatch(/return\s+main\s*\?/);

    const playbackReturn = playerSource.slice(playerSource.lastIndexOf("  return ("));
    expect(playbackReturn).toContain("<MainMultiRoomAsrProvider");
    expect(playbackReturn).toContain("active={main}");
    expect(playbackReturn).toContain("{stage}");
  });

  test("非主画面不会激活语音识别或采集当前媒体", () => {
    expect(playerSource).toContain("featureEnabled: asrEnabled && active");
    expect(playerSource).toContain("mediaAvailable: mediaAvailable && active");
  });

  test("禁用 ASR 的副画面切换媒体不会重置主画面全局识别流", () => {
    const asrSource = source("src/features/asr/useAsrCaptions.ts");
    const effectStart = asrSource.indexOf("// 切房间或换媒体元素时清空流式解码状态");
    const effect = asrSource.slice(effectStart, asrSource.indexOf("\n  ]);", effectStart));
    expect(effect).toContain("if (options.featureEnabled && model.supported)");
    expect(effect).toContain("options.featureEnabled,");
    expect(effect).not.toContain("if (model.supported) void invokeCmd");
  });
});

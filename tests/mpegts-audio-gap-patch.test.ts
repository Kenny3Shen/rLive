import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MPEGTS_AUDIO_GAP_FILL_MAX_MS,
  patchMpegtsAudioGapFill,
} from "../scripts/mpegts-audio-gap-patch";

const mpegtsDist = readFileSync(
  join(import.meta.dir, "../node_modules/mpegts.js/dist/mpegts.js"),
  "utf8",
);

const ORIGINAL_CONDITION = "if(o>=3*d&&this._fillAudioTimestampGap){";
const PATCHED_CONDITION = `if(o>=3*d&&o<=${MPEGTS_AUDIO_GAP_FILL_MAX_MS}&&this._fillAudioTimestampGap){`;

describe("mpegts.js 静音补帧缺口上限补丁", () => {
  test("真实安装产物补丁后带 10 秒上限且不再有无上限条件", () => {
    const patched = patchMpegtsAudioGapFill(mpegtsDist);
    expect(patched).toContain(PATCHED_CONDITION);
    expect(patched).not.toContain(ORIGINAL_CONDITION);
    expect(patched.split(PATCHED_CONDITION)).toHaveLength(2);
    // 只做锚点替换，其余产物不变。
    expect(patched.length).toBe(
      mpegtsDist.length + PATCHED_CONDITION.length - ORIGINAL_CONDITION.length,
    );
  });

  test("锚点缺失或重复时抛错，避免升级后补丁静默失效", () => {
    expect(() => patchMpegtsAudioGapFill("void 0;")).toThrow(/锚点失配/);
    expect(() => patchMpegtsAudioGapFill(`${mpegtsDist}${ORIGINAL_CONDITION}`)).toThrow(
      /实际匹配 2 处/,
    );
  });
});

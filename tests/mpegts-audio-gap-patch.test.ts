import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MPEGTS_AUDIO_GAP_FILL_MAX_MS,
  MPEGTS_AUDIO_GAP_VIDEO_TOLERANCE_MS,
  mpegtsAudioGapPluginName,
  patchMpegtsAudioGapFill,
} from "../scripts/mpegts-audio-gap-patch";

const mpegtsDist = readFileSync(
  join(import.meta.dir, "../node_modules/mpegts.js/dist/mpegts.js"),
  "utf8",
);

const ORIGINAL_CONDITION = "if(o>=3*d&&this._fillAudioTimestampGap){";
const PATCHED_CONDITION =
  "if(o>=3*d&&" +
  `o<=${MPEGTS_AUDIO_GAP_FILL_MAX_MS}&&` +
  `k<=this._videoNextDts+${MPEGTS_AUDIO_GAP_VIDEO_TOLERANCE_MS}&&` +
  "this._fillAudioTimestampGap){";

const ORIGINAL_ELSE = "else A=Math.floor(w),C=Math.floor(w+d)-A,this._audioNextDts=w+d}";
const PATCHED_ELSE =
  "else o>=3*d&&" +
  `k<=this._videoNextDts+${MPEGTS_AUDIO_GAP_VIDEO_TOLERANCE_MS}?` +
  "(A=Math.floor(k),C=Math.floor(k+d)-A,this._audioNextDts=k+d):" +
  "(A=Math.floor(w),C=Math.floor(w+d)-A,this._audioNextDts=w+d)}";

describe("mpegts.js 音频时间戳缺口补丁", () => {
  test("真实安装产物补丁后两处替换都生效", () => {
    const patched = patchMpegtsAudioGapFill(mpegtsDist);
    // 第一处：视频确认的缺口才补帧，且带 10 秒上限。
    expect(patched).toContain(PATCHED_CONDITION);
    expect(patched).not.toContain(ORIGINAL_CONDITION);
    expect(patched.split(PATCHED_CONDITION)).toHaveLength(2);
    // 第二处：视频确认的超限缺口使用原始 dts；未确认缺口仍压缩时间轴。
    expect(patched).toContain(PATCHED_ELSE);
    expect(patched).not.toContain(ORIGINAL_ELSE);
    expect(patched.split(PATCHED_ELSE)).toHaveLength(2);
    expect(patched).toContain("(A=Math.floor(w),C=Math.floor(w+d)-A,this._audioNextDts=w+d)}");
    // 只做锚点替换，其余产物不变。
    expect(patched.length).toBe(
      mpegtsDist.length +
        PATCHED_CONDITION.length -
        ORIGINAL_CONDITION.length +
        PATCHED_ELSE.length -
        ORIGINAL_ELSE.length,
    );
  });

  test("锚点缺失或重复时抛错，避免升级后补丁静默失效", () => {
    expect(() => patchMpegtsAudioGapFill("void 0;")).toThrow(/锚点失配（静音补帧缺口上限）/);
    expect(() => patchMpegtsAudioGapFill(`${mpegtsDist}${ORIGINAL_CONDITION}`)).toThrow(
      /锚点失配（静音补帧缺口上限）.*实际匹配 2 处/,
    );
    // 第二处锚点缺失时报错必须能指出是哪一处补丁。
    expect(() => patchMpegtsAudioGapFill(mpegtsDist.replace(ORIGINAL_ELSE, ""))).toThrow(
      /锚点失配（音视频确认的超限音频缺口跟随源时间轴）/,
    );
    expect(() => patchMpegtsAudioGapFill(`${mpegtsDist}${ORIGINAL_ELSE}`)).toThrow(
      /锚点失配（音视频确认的超限音频缺口跟随源时间轴）.*实际匹配 2 处/,
    );
  });

  test("插件名随替换内容变化，dev 预打包缓存才能自动失效", () => {
    const name = mpegtsAudioGapPluginName();
    expect(name).toMatch(/^rlive:mpegts-audio-gap@[0-9a-f]{8}$/);
    expect(mpegtsAudioGapPluginName()).toBe(name);
    expect(
      mpegtsAudioGapPluginName([
        {
          name: "静音补帧缺口上限",
          anchor: "if(o>=3*d&&this._fillAudioTimestampGap){",
          replacement: "x",
        },
      ]),
    ).not.toBe(name);
  });
});

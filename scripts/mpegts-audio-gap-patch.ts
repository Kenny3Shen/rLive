/**
 * mpegts.js 音频时间戳缺口的构建期补丁。
 *
 * 规则：只保留视频时间轴已经确认过的音频缺口。
 *
 * - 视频已确认、缺口 ≤ 10 秒：生成静音帧补齐，避免音画不同步。上限对齐
 *   hls.js 的同类做法，防止 `push.apply` 参数过多触发 V8 栈溢出。
 * - 视频已确认、缺口 > 10 秒：音频 dts 使用原始时间戳，`_audioNextDts` 也从
 *   原始 dts 续上，两轨在同一位置一起留空，交给 mpegts.js 的追帧跳到直播边缘。
 * - 未被视频确认的缺口（纯音频流、seek 重置后，或音频样本先于视频到达）沿用
 *   原压缩逻辑，把音频时间轴连续化。仅音频时间戳跳前而内容其实连续时，压缩
 *   才是正确结果；音频跳后样本先于视频到达时，这几帧会先被压缩，等下一批
 *   视频跟上后再按确认结果补帧或留空，这是预期的自愈行为。
 *
 * 缺口是否被视频确认由 `k <= this._videoNextDts + 容差` 判断：`_remuxVideo`
 * 先于 `_remuxAudio` 执行，视频 stash 末帧让 dtsCorrection 保持稳定，因此
 * `this._videoNextDts` ≈ 最新视频帧的原始 dts；没有视频或 seek 重置后它是
 * undefined，`undefined + 容差` 为 NaN，比较结果为 false。
 */
import { createHash } from "node:crypto";

import type { Plugin } from "vite";

/** 静音补帧可接受的最大音频时间戳缺口，单位 ms（remuxer 内部时间基）。 */
export const MPEGTS_AUDIO_GAP_FILL_MAX_MS = 10_000;

/**
 * 音频原始 dts 允许超前视频时间轴的容差，单位 ms。
 *
 * 覆盖 FLV 音视频交错带来的超前量：音频样本通常比同一时间点的视频样本早到，
 * 留出 1 秒余量才不会把真实的卡顿缺口误判成未确认缺口。
 */
export const MPEGTS_AUDIO_GAP_VIDEO_TOLERANCE_MS = 1_000;

export type MpegtsReplacement = {
  /** 失配报错时用于指出是哪一处补丁。 */
  name: string;
  /** mpegts.js 1.8.2 dist 产物中的精确片段，必须恰好出现一次。 */
  anchor: string;
  replacement: string;
};

/**
 * dist 产物是压缩后的单行 UMD，变量名已被压缩，升级后若失配必须复核补丁
 * 逻辑再更新锚点。变量含义：`k` 原始 dts，`w` 当前参考 dts，`d` 参考帧时长，
 * `o` 时间戳修正量，`this._videoNextDts` 视频时间轴的下一帧 dts。
 */
const MPEGTS_REPLACEMENTS: readonly MpegtsReplacement[] = [
  {
    name: "静音补帧缺口上限",
    anchor: "if(o>=3*d&&this._fillAudioTimestampGap){",
    replacement:
      "if(o>=3*d&&" +
      `o<=${MPEGTS_AUDIO_GAP_FILL_MAX_MS}&&` +
      `k<=this._videoNextDts+${MPEGTS_AUDIO_GAP_VIDEO_TOLERANCE_MS}&&` +
      "this._fillAudioTimestampGap){",
  },
  {
    name: "音视频确认的超限音频缺口跟随源时间轴",
    anchor: "else A=Math.floor(w),C=Math.floor(w+d)-A,this._audioNextDts=w+d}",
    replacement:
      "else o>=3*d&&" +
      `k<=this._videoNextDts+${MPEGTS_AUDIO_GAP_VIDEO_TOLERANCE_MS}?` +
      "(A=Math.floor(k),C=Math.floor(k+d)-A,this._audioNextDts=k+d):" +
      "(A=Math.floor(w),C=Math.floor(w+d)-A,this._audioNextDts=w+d)}",
  },
];

const MPEGTS_DIST_MODULE_SUFFIX = "/node_modules/mpegts.js/dist/mpegts.js";

/**
 * 插件名带上替换表内容的短哈希。
 *
 * Vite 的 `getConfigHash` 会把普通 `plugins` 的名字纳入依赖预打包缓存键，却会
 * 剔除 `optimizeDeps.rolldownOptions.plugins`；名字随替换内容变化，dev 预打包
 * 才能在补丁更新后自动失效，不必手动清缓存。两处挂载使用同一个名字。
 */
export function mpegtsAudioGapPluginName(
  replacements: readonly MpegtsReplacement[] = MPEGTS_REPLACEMENTS,
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        replacements.map(({ name, anchor, replacement }) => [name, anchor, replacement]),
      ),
    )
    .digest("hex")
    .slice(0, 8);
  return `rlive:mpegts-audio-gap@${hash}`;
}

/** 判断模块 id 是否指向 mpegts.js 的 dist 产物（Windows 路径也归一化）。 */
function isMpegtsDistModule(id: string): boolean {
  return id.replaceAll("\\", "/").includes(MPEGTS_DIST_MODULE_SUFFIX);
}

/**
 * 依次应用两处替换：视频确认且 ≤ 10 秒的缺口补静音帧，视频确认的更大缺口
 * 跟随源时间轴，其余缺口压缩成连续时间轴。
 *
 * 每个锚点必须恰好出现一次，否则说明 mpegts.js 升级改变了产物结构：直接抛错
 * 让构建失败，避免补丁静默失效。
 */
export function patchMpegtsAudioGapFill(code: string): string {
  let patched = code;
  for (const { name, anchor, replacement } of MPEGTS_REPLACEMENTS) {
    const matched = patched.split(anchor).length - 1;
    if (matched !== 1) {
      throw new Error(
        `mpegts.js 补丁锚点失配（${name}）：预期 1 处，实际匹配 ${matched} 处。` +
          `锚点：${anchor}。` +
          "mpegts.js 升级后需复核 scripts/mpegts-audio-gap-patch.ts 的锚点与替换逻辑。",
      );
    }
    patched = patched.replace(anchor, () => replacement);
  }
  return patched;
}

/**
 * Vite 插件：同时用于普通构建的 `plugins` 与 dev 依赖预打包的
 * `optimizeDeps.rolldownOptions.plugins`，保证两条路径拿到同一份补丁。
 */
export function mpegtsAudioGapFillPlugin(): Plugin {
  return {
    name: mpegtsAudioGapPluginName(),
    enforce: "pre",
    transform(code, id) {
      if (!isMpegtsDistModule(id)) return null;
      return { code: patchMpegtsAudioGapFill(code), map: null };
    },
  };
}

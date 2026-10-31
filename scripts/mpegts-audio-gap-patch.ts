/**
 * mpegts.js 静音补帧的缺口上限补丁。
 *
 * mpegts.js 的 mp4-remuxer 在 AAC 帧之间发现时间戳缺口时会生成静音帧补齐，
 * 避免音画不同步；但帧数不设上限，缺口越大 `push.apply` 的参数越多，
 * 足够长的缺口会超过 V8 的参数数量上限并抛栈溢出。关闭补帧又会在卡顿后
 * 永久丢失时间轴差，导致音频领先视频。
 *
 * 因此保留补帧，只把可补的缺口限制在 10 秒以内（对齐 hls.js 的同类上限）：
 * 帧数最多约几千，不再触发调用栈问题；更大的缺口按时间轴断裂处理，仍走
 * 原有的不补帧分支。
 */
import type { Plugin } from "vite";

/** 静音补帧可接受的最大音频时间戳缺口，单位 ms（remuxer 内部时间基）。 */
export const MPEGTS_AUDIO_GAP_FILL_MAX_MS = 10_000;

/**
 * mpegts.js 1.8.2 dist 产物中的精确条件片段。产物是压缩后的单行 UMD，
 * 变量名已被压缩，升级后若失配必须复核补丁逻辑再更新锚点。
 */
const MPEGTS_AUDIO_GAP_FILL_ANCHOR = "if(o>=3*d&&this._fillAudioTimestampGap){";

const MPEGTS_AUDIO_GAP_FILL_PATCHED = `if(o>=3*d&&o<=${MPEGTS_AUDIO_GAP_FILL_MAX_MS}&&this._fillAudioTimestampGap){`;

const MPEGTS_DIST_MODULE_SUFFIX = "/node_modules/mpegts.js/dist/mpegts.js";

/** 判断模块 id 是否指向 mpegts.js 的 dist 产物（Windows 路径也归一化）。 */
export function isMpegtsDistModule(id: string): boolean {
  return id.replaceAll("\\", "/").includes(MPEGTS_DIST_MODULE_SUFFIX);
}

/**
 * 把无上限的静音补帧条件替换为带 10 秒上限的条件。
 *
 * 锚点必须恰好出现一次，否则说明 mpegts.js 升级改变了产物结构：直接抛错让
 * 构建失败，避免补丁静默失效后重新引入无上限补帧。
 */
export function patchMpegtsAudioGapFill(code: string): string {
  const matched = code.split(MPEGTS_AUDIO_GAP_FILL_ANCHOR).length - 1;
  if (matched !== 1) {
    throw new Error(
      `mpegts.js 静音补帧补丁锚点失配：预期 1 处，实际匹配 ${matched} 处。` +
        "mpegts.js 升级后需复核 scripts/mpegts-audio-gap-patch.ts 的锚点与上限逻辑。",
    );
  }
  return code.replace(MPEGTS_AUDIO_GAP_FILL_ANCHOR, () => MPEGTS_AUDIO_GAP_FILL_PATCHED);
}

/**
 * Vite 插件：同时用于普通构建的 `plugins` 与 dev 依赖预打包的
 * `optimizeDeps.rolldownOptions.plugins`，保证两条路径拿到同一份补丁。
 */
export function mpegtsAudioGapFillPlugin(): Plugin {
  return {
    name: "rlive:mpegts-audio-gap-fill-limit",
    enforce: "pre",
    transform(code, id) {
      if (!isMpegtsDistModule(id)) return null;
      return { code: patchMpegtsAudioGapFill(code), map: null };
    },
  };
}

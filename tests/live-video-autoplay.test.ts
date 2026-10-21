import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requestPlayerAutoplay } from "../src/features/room/player/autoplay";

const root = join(import.meta.dir, "..");

/** 取出直播画面里 `<VideoJsVideo ...>` 的属性片段；key 用来定位每个播放舞台。 */
function videoJsVideoAttributes(file: string, marker: string): string {
  const source = readFileSync(join(root, file), "utf8");
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** 只取出实际调用（含闭括号），避免从 import 一直跨到后文。 */
function extractRequestPlayerAutoplayCall(source: string): string {
  const match = /requestPlayerAutoplay\(\s*player,\s*video,/.exec(source);
  expect(match).not.toBeNull();
  const start = match!.index;
  let depth = 0;
  for (let i = start + "requestPlayerAutoplay".length; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("requestPlayerAutoplay 调用没有闭合");
}

describe("直播 <video> 不再自带浏览器自动起播", () => {
  test.each([
    ["src/features/room/PlayerPane.tsx", "key={player.mediaKey}"],
    ["src/features/multi-room/MultiRoomPlayer.tsx", "key={player.mediaKey}"],
  ])("%s 的 VideoJsVideo 不带 autoPlay", (file, marker) => {
    // 浏览器自动起播会绕过 useWebPlayer 的用户暂停记账：自动恢复或续期重建时
    // 即使用户按过暂停，新节点也会自行开始播放。
    expect(videoJsVideoAttributes(file, marker)).not.toMatch(/\bautoPlay\b/);
  });

  test("唯一自动起播入口仍是 requestPlayerAutoplay，并核对用户暂停意图", () => {
    const source = readFileSync(join(root, "src/features/room/player/useWebPlayer.ts"), "utf8");
    const call = extractRequestPlayerAutoplayCall(source);
    // 锁定真实调用本身：player / video 在前，第三参数是起播判定回调。
    expect(call).toMatch(/^requestPlayerAutoplay\(\s*player,\s*video,/);
    // 起播判定与异步重试都经由这个 isCurrent 回调；用户暂停后它返回 false。
    const pauseGuard = /\(\)\s*=>\s*isCurrentPlayer\(\)\s*&&\s*!userPausedRef\.current/;
    expect(call).toMatch(pauseGuard);

    // 负向对照：把回调改成只判 isCurrentPlayer 后，后文 resumePlayback 里的
    // !userPausedRef.current 仍在（宽泛的跨调用 regex 会因此误判通过），
    // 但收窄到调用内部的断言必须失败。
    const tamperedCall = call.replace(pauseGuard, "() => isCurrentPlayer()");
    expect(tamperedCall).not.toBe(call);
    const tamperedSource =
      source.slice(0, source.indexOf(call)) +
      tamperedCall +
      source.slice(source.indexOf(call) + call.length);
    expect(tamperedSource).toContain("resumePlayback = !userPausedRef.current");
    expect(tamperedSource).toContain("!userPausedRef.current");
    expect(extractRequestPlayerAutoplayCall(tamperedSource)).not.toMatch(pauseGuard);
  });

  test("用户已暂停时既有入口不发起播放", async () => {
    let playCalls = 0;
    const player = {
      play: () => {
        playCalls += 1;
        return Promise.resolve();
      },
    };
    requestPlayerAutoplay(player, { muted: false }, () => false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(playCalls).toBe(0);
  });
});

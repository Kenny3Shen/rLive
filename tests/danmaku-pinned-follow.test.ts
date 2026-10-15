import { describe, expect, test } from "bun:test";
import {
  DANMAKU_PINNED_TOLERANCE_PX,
  DANMAKU_REPIN_THRESHOLD_PX,
  isDanmakuViewportAtBottom,
} from "../src/features/room/danmaku/pinnedFollow";

describe("直播弹幕列表贴底判定", () => {
  test("两条容差相差一个数量级，钉底那条必须远小于阅读态", () => {
    expect(DANMAKU_PINNED_TOLERANCE_PX).toBeLessThan(DANMAKU_REPIN_THRESHOLD_PX / 10);
  });

  test("钉底时程序性夹取（距底 0）仍算在底部", () => {
    expect(isDanmakuViewportAtBottom(0, true)).toBe(true);
    expect(isDanmakuViewportAtBottom(DANMAKU_PINNED_TOLERANCE_PX - 0.01, true)).toBe(true);
  });

  test("钉底时一次小格滚轮（30px 意图）必须被读成离开底部", () => {
    // 这是本判定的核心回归点：若沿用 48px 宽带，30px 上滚会被判为「仍在底部」，
    // 钉底逻辑随即把视口拉回去，用户的小幅上滚永远离不开底部。
    expect(isDanmakuViewportAtBottom(30, true)).toBe(false);
    expect(isDanmakuViewportAtBottom(47, true)).toBe(false);
    expect(isDanmakuViewportAtBottom(48, true)).toBe(false);
  });

  test("阅读态滚回底部（48px 宽带内）重新跟随", () => {
    expect(isDanmakuViewportAtBottom(0, false)).toBe(true);
    expect(isDanmakuViewportAtBottom(47, false)).toBe(true);
    expect(isDanmakuViewportAtBottom(48, false)).toBe(false);
  });

  test("阅读态停在半途不算贴底", () => {
    expect(isDanmakuViewportAtBottom(200, false)).toBe(false);
  });

  test("非有限距离按不在底部处理，不把未知读成跟随", () => {
    expect(isDanmakuViewportAtBottom(Number.NaN, true)).toBe(false);
    expect(isDanmakuViewportAtBottom(Number.POSITIVE_INFINITY, true)).toBe(false);
    expect(isDanmakuViewportAtBottom(Number.NEGATIVE_INFINITY, true)).toBe(false);
  });

  test("越界夹取后回读的负距离（视口高于内容）仍算在底部", () => {
    expect(isDanmakuViewportAtBottom(-120, true)).toBe(true);
    expect(isDanmakuViewportAtBottom(-120, false)).toBe(true);
  });
});

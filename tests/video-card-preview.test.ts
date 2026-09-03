import { describe, expect, test } from "bun:test";
import {
  ROOM_CARD_PREVIEW_DELAY_MS,
  isRoomCardPreviewPointer,
  supportsRoomCardPreview,
} from "../src/features/room/player/roomCardPreview";

/**
 * 视频卡悬停预览复用直播卡的通用件（判定、延迟常量、表面样式类），
 * 这里钉住两件事：复用的约定不被直播侧悄悄改动，以及 VOD 自己的门控
 * 与直播同语义（见 `useVideoCardPreview` 的 enabled/cid 判定）。
 */
describe("video card hover preview contract", () => {
  test("reuses the room card dwell delay and pointer gate", () => {
    // 悬停延迟是产品语义（扫过整行卡片不触发预览），两侧必须一致。
    expect(ROOM_CARD_PREVIEW_DELAY_MS).toBe(600);
    expect(isRoomCardPreviewPointer("mouse")).toBe(true);
    expect(isRoomCardPreviewPointer("touch")).toBe(false);
    expect(isRoomCardPreviewPointer("pen")).toBe(false);
  });

  test("keeps desktop-only motion-tolerant gating identical to live cards", () => {
    expect(supportsRoomCardPreview({ mobile: false, finePointer: true, reducedMotion: false }))
      .toBe(true);
    // 触摸端、粗指针、减少动态效果：与直播卡同样的否决集。
    expect(supportsRoomCardPreview({ mobile: true, finePointer: true, reducedMotion: false }))
      .toBe(false);
    expect(supportsRoomCardPreview({ mobile: false, finePointer: false, reducedMotion: false }))
      .toBe(false);
    expect(supportsRoomCardPreview({ mobile: false, finePointer: true, reducedMotion: true }))
      .toBe(false);
  });
});

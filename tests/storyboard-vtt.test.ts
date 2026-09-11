import { describe, expect, it } from "bun:test";
import { storyboardToVtt } from "@/features/video/storyboardVtt";
import type { VideoStoryboard } from "@/shared/types/video";
import { parseMediaFragment, mapCuesToThumbnails } from "@videojs/core";

describe("storyboardToVtt", () => {
  it("converts valid Bilibili storyboard into WebVTT cues with sprite coordinates", () => {
    const mockStoryboard: VideoStoryboard = {
      img_x_len: 10,
      img_y_len: 10,
      img_x_size: 160,
      img_y_size: 90,
      images: [
        "//i0.hdslb.com/bfs/videoshot/49075258.jpg",
        "//i0.hdslb.com/bfs/videoshot/49075258-1.jpg",
      ],
      index: [0, 0, 8, 14, 19, 25],
    };

    const vtt = storyboardToVtt(mockStoryboard, 30);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);

    const cues = vtt.trim().split("\n\n").slice(1);
    expect(cues.length).toBe(5);

    // Frame 0: 0s -> 8s, col 0, row 0
    expect(cues[0]).toBe(
      "00:00:00.000 --> 00:00:08.000\nhttps://i0.hdslb.com/bfs/videoshot/49075258.jpg#xywh=0,0,160,90",
    );

    // Frame 1: 8s -> 14s, col 1, row 0
    expect(cues[1]).toBe(
      "00:00:08.000 --> 00:00:14.000\nhttps://i0.hdslb.com/bfs/videoshot/49075258.jpg#xywh=160,0,160,90",
    );

    // Frame 2: 14s -> 19s, col 2, row 0
    expect(cues[2]).toBe(
      "00:00:14.000 --> 00:00:19.000\nhttps://i0.hdslb.com/bfs/videoshot/49075258.jpg#xywh=320,0,160,90",
    );

    // Last frame: 25s -> videoDuration (30s), col 4, row 0
    expect(cues[4]).toBe(
      "00:00:25.000 --> 00:00:30.000\nhttps://i0.hdslb.com/bfs/videoshot/49075258.jpg#xywh=640,0,160,90",
    );
  });

  it("advances across sprite sheets when frame index exceeds perSheet capacity", () => {
    // 2x2 grid (4 frames per sheet)
    const mockStoryboard: VideoStoryboard = {
      img_x_len: 2,
      img_y_len: 2,
      img_x_size: 160,
      img_y_size: 90,
      images: [
        "https://example.com/sheet0.jpg",
        "https://example.com/sheet1.jpg",
      ],
      // 5 frames: indices 0..4 (times: 0, 5, 10, 15, 20)
      index: [0, 0, 5, 10, 15, 20],
    };

    const vtt = storyboardToVtt(mockStoryboard, 25);
    const cues = vtt.trim().split("\n\n").slice(1);
    expect(cues.length).toBe(5);

    // Frame 0: sheet0, col 0, row 0 -> 0, 0
    expect(cues[0]).toContain("https://example.com/sheet0.jpg#xywh=0,0,160,90");
    // Frame 1: sheet0, col 1, row 0 -> 160, 0
    expect(cues[1]).toContain("https://example.com/sheet0.jpg#xywh=160,0,160,90");
    // Frame 2: sheet0, col 0, row 1 -> 0, 90
    expect(cues[2]).toContain("https://example.com/sheet0.jpg#xywh=0,90,160,90");
    // Frame 3: sheet0, col 1, row 1 -> 160, 90
    expect(cues[3]).toContain("https://example.com/sheet0.jpg#xywh=160,90,160,90");
    // Frame 4: sheet1, col 0, row 0 -> 0, 0
    expect(cues[4]).toContain("https://example.com/sheet1.jpg#xywh=0,0,160,90");
  });

  it("handles empty or invalid storyboard gracefully", () => {
    expect(storyboardToVtt(null)).toBe("");
    expect(storyboardToVtt(undefined)).toBe("");
    expect(
      storyboardToVtt({
        img_x_len: 10,
        img_y_len: 10,
        img_x_size: 160,
        img_y_size: 90,
        images: [],
        index: [0, 0, 10],
      }),
    ).toBe("");
    expect(
      storyboardToVtt({
        img_x_len: 10,
        img_y_len: 10,
        img_x_size: 160,
        img_y_size: 90,
        images: ["https://example.com/sheet.jpg"],
        index: [],
      }),
    ).toBe("");
  });

  it("ensures cue end time is always strictly greater than start time", () => {
    const mockStoryboard: VideoStoryboard = {
      img_x_len: 10,
      img_y_len: 10,
      img_x_size: 160,
      img_y_size: 90,
      images: ["https://example.com/sheet.jpg"],
      // consecutive identical timestamps
      index: [0, 0, 0, 5],
    };

    const vtt = storyboardToVtt(mockStoryboard);
    const cues = vtt.trim().split("\n\n").slice(1);
    expect(cues[0]).toContain("00:00:00.000 --> 00:00:01.000");
  });

  it("is fully compatible with Video.js media fragment parser and mapCuesToThumbnails", () => {
    const mockStoryboard: VideoStoryboard = {
      img_x_len: 10,
      img_y_len: 10,
      img_x_size: 160,
      img_y_size: 90,
      images: ["https://i0.hdslb.com/bfs/videoshot/123.jpg"],
      index: [0, 0, 10, 20],
    };

    const vtt = storyboardToVtt(mockStoryboard, 30);
    const cueLines = vtt.trim().split("\n\n").slice(1);

    const parsedCues = cueLines.map((block) => {
      const [timing, payload] = block.split("\n");
      const [startStr, endStr] = timing.split(" --> ");
      const toSec = (s: string) => {
        const [h, m, sec] = s.split(":");
        return Number(h) * 3600 + Number(m) * 60 + Number(sec);
      };
      return {
        startTime: toSec(startStr),
        endTime: toSec(endStr),
        text: payload,
      };
    });

    const parsedThumbnails = mapCuesToThumbnails(parsedCues);
    expect(parsedThumbnails.length).toBe(3);

    expect(parsedThumbnails[0]).toEqual({
      url: "https://i0.hdslb.com/bfs/videoshot/123.jpg",
      startTime: 0,
      endTime: 10,
      width: 160,
      height: 90,
      coords: { x: 0, y: 0 },
    });

    expect(parsedThumbnails[1]).toEqual({
      url: "https://i0.hdslb.com/bfs/videoshot/123.jpg",
      startTime: 10,
      endTime: 20,
      width: 160,
      height: 90,
      coords: { x: 160, y: 0 },
    });

    expect(parsedThumbnails[2]).toEqual({
      url: "https://i0.hdslb.com/bfs/videoshot/123.jpg",
      startTime: 20,
      endTime: 30,
      width: 160,
      height: 90,
      coords: { x: 320, y: 0 },
    });

    const frag = parseMediaFragment(parsedCues[1].text);
    expect(frag.coords).toEqual({ x: 160, y: 0 });
    expect(frag.width).toBe(160);
    expect(frag.height).toBe(90);
  });
});

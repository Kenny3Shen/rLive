import { describe, expect, test } from "bun:test";
import {
  isVideoTailBuffered,
  VIDEO_TAIL_BUFFER_EPSILON_SECONDS,
  type BufferedRanges,
} from "../src/features/video/videoTailBuffer";

/**
 * 下一分集预加载的闸门：末片进缓冲之前不该碰下一集的取流。
 *
 * 判据是媒体元素 `buffered` 的末端触到时长。MSE 下这个值是视频与音频两条轨
 * 缓冲区间的交集（规范如此），因此它触底意味着两条轨的末片都已就位。
 */

/** 用普通对象顶替 TimeRanges：只用到 `length` 与 `end`。 */
function ranges(...ends: number[]): BufferedRanges {
  return {
    length: ends.length,
    end: (index: number) => {
      const value = ends[index];
      if (value === undefined) throw new RangeError("IndexSizeError");
      return value;
    },
  };
}

describe("末片缓冲判定", () => {
  test("缓冲末端触到时长才算末片就位", () => {
    expect(isVideoTailBuffered(ranges(10, 60), 60)).toBe(true);
    // 离片尾还差 0.5s：超出容差，仍是「最后一片还没到」。
    expect(isVideoTailBuffered(ranges(10, 59.5), 60)).toBe(false);
  });

  test("容差只吸收时间轴浮点误差，不放过整整一个分片", () => {
    const duration = 60;
    // 分片时长远大于容差：倒数第二片到片尾的距离必然超过它。
    expect(
      isVideoTailBuffered(ranges(duration - VIDEO_TAIL_BUFFER_EPSILON_SECONDS / 2), duration),
    ).toBe(true);
    expect(isVideoTailBuffered(ranges(duration - 2), duration)).toBe(false);
    expect(VIDEO_TAIL_BUFFER_EPSILON_SECONDS).toBeLessThan(1);
  });

  test("音频轨多出的小数尾巴不影响判定", () => {
    // 实测音轨时长可略长于视频轨（24 条样本最大 +0.035s），播放器的 buffered
    // 取两者交集，末端只会落在较短的那条上。
    expect(isVideoTailBuffered(ranges(65.7933), 65.7933)).toBe(true);
  });

  test("没有缓冲、时长为 0 或未知时一律判否", () => {
    expect(isVideoTailBuffered(ranges(), 60)).toBe(false);
    expect(isVideoTailBuffered(null, 60)).toBe(false);
    expect(isVideoTailBuffered(undefined, 60)).toBe(false);
    expect(isVideoTailBuffered(ranges(60), 0)).toBe(false);
    expect(isVideoTailBuffered(ranges(60), Number.NaN)).toBe(false);
    expect(isVideoTailBuffered(ranges(60), Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("TimeRanges 在并发清理中失效时按未触底处理", () => {
    // 末段被 dash.js 剪掉后旧引用的 end() 会抛 IndexSizeError。
    expect(isVideoTailBuffered(ranges(10), 60)).toBe(false);
    const throwing: BufferedRanges = {
      length: 2,
      end: () => {
        throw new RangeError("IndexSizeError");
      },
    };
    expect(isVideoTailBuffered(throwing, 60)).toBe(false);
  });
});

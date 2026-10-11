import { describe, expect, test } from "bun:test";
import {
  createVideoJsPlayer,
  loadVideoJsModules,
} from "../src/features/room/player/videoJsPlayer";
import { MediaStub } from "./helpers/media";

/** 只桩可观察的媒体副作用；load 会丢缓冲，用来抓角色提升误重载。 */
class Media extends MediaStub {
  preload = "metadata";
  loads = 0;
  bufferedSeconds = 0;
  load() {
    this.loads += 1;
    this.bufferedSeconds = 0;
  }
}

function nativePlayer() {
  const media = new Media();
  const player = createVideoJsPlayer(
    {},
    {
      video: media as unknown as HTMLVideoElement,
      kind: "native",
      url: "http://127.0.0.1/one.mp4",
      isLive: false,
    },
  );
  return { media, player };
}

describe("短视频原生播放器复用", () => {
  test("原生加载无需 DASH/HLS 内核", async () => {
    expect(await loadVideoJsModules("native")).toEqual({});
  });

  test("换源保留播放器、媒体及监听，同 URL 不重复 load", () => {
    const { media, player } = nativePlayer();
    let readyEvents = 0;
    player.on("canplay", () => {
      readyEvents += 1;
    });
    media.dispatchEvent(new Event("canplay"));
    expect(media.loads).toBe(1);
    media.currentTime = 13;
    media.dispatchEvent(new Event("ended"));
    expect(player.ended).toBe(true);
    player.switchNativeSource("http://127.0.0.1/two.mp4");
    expect(player.media).toBe(media as unknown as HTMLVideoElement);
    expect(media.src).toBe("http://127.0.0.1/two.mp4");
    expect(media.loads).toBe(2);
    expect(player.ended).toBe(false);
    media.bufferedSeconds = 4;
    player.switchNativeSource("http://127.0.0.1/two.mp4");
    expect(media.loads).toBe(2);
    expect(media.bufferedSeconds).toBe(4);
    media.dispatchEvent(new Event("canplay"));
    expect(readyEvents).toBe(2);
    player.destroy();
    player.destroy();
    expect(media.loads).toBe(3);
    media.dispatchEvent(new Event("canplay"));
    expect(readyEvents).toBe(2);
  });

  test("warm → paused → active 只改 preload，不丢已预热缓冲", () => {
    const { media, player } = nativePlayer();
    media.bufferedSeconds = 5;
    player.setShortsBufferMode("warm");
    expect(media.preload).toBe("auto");
    player.setShortsBufferMode("paused");
    expect(media.preload).toBe("none");
    player.setShortsBufferMode("active");
    expect(media.preload).toBe("auto");
    expect(media.loads).toBe(1);
    expect(media.bufferedSeconds).toBe(5);
    expect(media.src).toBe("http://127.0.0.1/one.mp4");
    expect(media.paused).toBe(true);
    player.destroy();
    const loads = media.loads;
    player.setShortsBufferMode("paused");
    player.switchNativeSource("http://127.0.0.1/three.mp4");
    expect(media.loads).toBe(loads);
    expect(media.src).toBe("");
  });

  test("原生槽位不扩大直播 switchSource 的软切协议边界", async () => {
    const { media, player } = nativePlayer();
    await expect(player.switchSource("http://127.0.0.1/two.mp4", "native")).rejects.toThrow(
      "当前协议不支持软切换",
    );
    expect(media.loads).toBe(1);
    expect(media.src).toBe("http://127.0.0.1/one.mp4");
    player.destroy();
  });
});

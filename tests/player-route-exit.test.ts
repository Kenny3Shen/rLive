import { describe, expect, test } from "bun:test";
import { createMemoryRouter } from "react-router-dom";
import { isVideoPlayerTimeQuiet } from "../src/components/videojs/lib/player-time-quiet";
import { watchPlayerRouteExit } from "../src/shared/player/playerExitQuiet";
import { createPlaybackClock } from "../src/features/video/videoPlaybackClock";

describe("播放页共用离场静默", () => {
  test("真实 Router 的 POP 离场静默，前进重入恢复，退订后不再影响媒体", async () => {
    const router = createMemoryRouter(
      [{ path: "/", element: null }, { path: "/room/test", element: null }],
      { initialEntries: ["/", "/room/test"], initialIndex: 1 },
    );
    const media = { currentTime: 10 } as HTMLVideoElement;
    const stop = watchPlayerRouteExit(router, router.state.location.key, {
      videoRef: { current: media },
    });
    try {
      expect(isVideoPlayerTimeQuiet(media)).toBe(false);
      await router.navigate(-1);
      expect(isVideoPlayerTimeQuiet(media)).toBe(true);
      await router.navigate(1);
      expect(isVideoPlayerTimeQuiet(media)).toBe(false);
      stop();
      await router.navigate(-1);
      expect(isVideoPlayerTimeQuiet(media)).toBe(false);
    } finally {
      stop();
      router.dispose();
    }
  });

  test("守卫拒绝返回时保持媒体与回放时钟正常更新", async () => {
    const router = createMemoryRouter(
      [{ path: "/", element: null }, { path: "/recordings/play/test", element: null }],
      { initialEntries: ["/recordings/play/test"] },
    );
    const media = { currentTime: 10 } as HTMLVideoElement;
    const clock = createPlaybackClock(10);
    let notifications = 0;
    clock.subscribe(() => notifications++);
    const stop = watchPlayerRouteExit(router, router.state.location.key, {
      videoRef: { current: media },
      clock,
    });
    try {
      router.getBlocker("recording", () => true);
      await router.navigate("/", { replace: true });
      expect(router.state.blockers.get("recording")?.state).toBe("blocked");
      expect(isVideoPlayerTimeQuiet(media)).toBe(false);
      clock.set(11);
      expect(notifications).toBe(1);
    } finally {
      stop();
      router.dispose();
    }
  });

  test("REPLACE 离场后卸载不补发时钟，也清理最初标记的媒体", async () => {
    const router = createMemoryRouter(
      [{ path: "/iptv", element: null }, { path: "/iptv/play", element: null }],
      { initialEntries: ["/iptv/play"] },
    );
    const media = { currentTime: 10 } as HTMLVideoElement;
    const videoRef = { current: media };
    const clock = createPlaybackClock(10);
    let notifications = 0;
    clock.subscribe(() => notifications++);
    const stop = watchPlayerRouteExit(router, router.state.location.key, { videoRef, clock });
    try {
      await router.navigate("/iptv", { replace: true });
      expect(isVideoPlayerTimeQuiet(media)).toBe(true);
      clock.set(12);
      videoRef.current = { currentTime: 12 } as HTMLVideoElement;
      stop();
      expect(isVideoPlayerTimeQuiet(media)).toBe(false);
      expect(notifications).toBe(0);
    } finally {
      stop();
      router.dispose();
    }
  });
});

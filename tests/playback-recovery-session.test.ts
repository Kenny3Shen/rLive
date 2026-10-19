import { describe, expect, test } from "bun:test";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl } from "../src/shared/types/live";
import {
  createPlaybackRecoverySession,
  type PlaybackRecoveryMetadataAdapter,
  type PlaybackRecoverySession,
} from "../src/features/room/playback/playbackRecoverySession";

const detail: LiveRoomDetail = {
  site_id: "bilibili",
  room_id: "1000",
  title: "直播间",
  cover: "",
  user_name: "主播",
  user_avatar: "",
  online: 1,
  status: true,
  notice: "",
  url: "https://live.bilibili.com/1000",
  raw: {},
};

const quality: LivePlayQuality = { quality: "原画", data: 10000 };

function flvSource(url = "https://cdn.example/live.flv?token=one"): PlayUrl {
  return {
    source_id: "bilibili:1",
    label: "线路1",
    protocol: "flv",
    priority: 0,
    url,
    headers: { referer: "https://live.bilibili.com" },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createSession(lines: () => PlayUrl[]) {
  const metadata: PlaybackRecoveryMetadataAdapter = {
    fetchQualities: async () => [quality],
    fetchLines: async () => lines(),
    cacheQualities: () => {},
    cacheLines: () => {},
  };
  const session = createPlaybackRecoverySession(
    {
      siteId: "bilibili",
      roomId: "1000",
      detail: undefined,
      qualityLevel: "high",
      enabled: false,
    },
    { metadata },
  );
  session.updateConfig({
    siteId: "bilibili",
    roomId: "1000",
    detail,
    qualityLevel: "high",
    enabled: true,
  });
  return session;
}

async function startedSession(lines: () => PlayUrl[]): Promise<PlaybackRecoverySession> {
  const session = createSession(lines);
  await flush();
  await flush();
  return session;
}

describe("播放恢复会话的续期语义", () => {
  test("自动续期只递增 renewToken，不触发表层完整重建", async () => {
    const session = await startedSession(() => [flvSource()]);
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/live.flv?token=one");

    session.acceptTransportFact({ epoch: 1, generation: 1, kind: "eof", protocol: "flv" });
    await flush();
    await flush();

    const snapshot = session.getSnapshot();
    // 上游关闭后重新取到同一个签名地址：连接必须重开，但不应重建播放器。
    expect(snapshot.renewToken).toBe(1);
    expect(snapshot.reloadToken).toBe(0);
    expect(snapshot.playUrl?.url).toBe("https://cdn.example/live.flv?token=one");
    session.dispose();
  });

  test("手动刷新仍按用户意图完整重建", async () => {
    const session = await startedSession(() => [flvSource()]);
    session.refresh();
    await flush();
    await flush();

    const snapshot = session.getSnapshot();
    expect(snapshot.reloadToken).toBe(1);
    expect(snapshot.renewToken).toBe(0);
    session.dispose();
  });

  test("同线路原地重试使用续期信号", async () => {
    const session = await startedSession(() => [flvSource()]);
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "error",
      protocol: "flv",
      message: "网络中断",
    });
    await flush();

    const snapshot = session.getSnapshot();
    expect(snapshot.renewToken).toBe(1);
    expect(snapshot.reloadToken).toBe(0);
    session.dispose();
  });

  test("续期后协议变化时退回完整重建", async () => {
    let next: PlayUrl[] = [flvSource()];
    const session = await startedSession(() => next);

    next = [
      {
        ...flvSource("https://cdn.example/live.m3u8?token=two"),
        protocol: "hls",
      },
    ];
    session.acceptTransportFact({ epoch: 1, generation: 1, kind: "eof", protocol: "flv" });
    await flush();
    await flush();

    const snapshot = session.getSnapshot();
    expect(snapshot.playUrl?.protocol).toBe("hls");
    expect(snapshot.reloadToken).toBe(1);
    expect(snapshot.renewToken).toBe(0);
    session.dispose();
  });
});

import { describe, expect, test } from "bun:test";
import {
  quietPlayerStoreSet,
  REGISTERED_MEDIA,
  setVideoPlayerTimeQuiet,
} from "../src/components/videojs/lib/player-time-quiet";

const media = {} as HTMLMediaElement;
const facade = { [REGISTERED_MEDIA]: media } as unknown as HTMLMediaElement;

describe("VOD 离场 Player store 写入静默", () => {
  test("媒体 facade 与真实元素共用同一标记，静默时写入不会发布", () => {
    const published: object[] = [];
    const publish = quietPlayerStoreSet(facade, (patch: object) => published.push(patch));
    setVideoPlayerTimeQuiet(media, true);
    publish({ currentTime: 10 });
    setVideoPlayerTimeQuiet(facade, false);
    publish({ currentTime: 11 });
    expect(published).toEqual([{ currentTime: 11 }]);
  });

  test("未标记静默的媒体保持原有写入", () => {
    const published: object[] = [];
    const publish = quietPlayerStoreSet(media, (patch: object) => published.push(patch));
    publish({ currentTime: 12 });
    expect(published).toEqual([{ currentTime: 12 }]);
  });
});

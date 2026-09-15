import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { videoGetDanmaku } from "@/features/video/videoApi";
import {
  mergeVideoDanmakuEntries,
  videoDanmakuEntries,
  videoDanmakuSegmentsFor,
  type VideoDanmakuEntry,
} from "@/features/video/videoDanmaku";

/**
 * 竖屏舞台的 VOD 弹幕分段加载。
 *
 * 与播放页同一套上游语义（6 分钟一段、`has_more === false` 表示段号越界），
 * 但去掉了播放页需要的加载态记账：竖屏没有弹幕栏，没有「暂无弹幕」要宣布，
 * 分段失败静默重试即可。短视频绝大多数落在第 0 段内（story 实测最长 309s），
 * 仍按段号推进是为了正确处理偶发的长条目。
 *
 * `cid` 变化即换片：必须丢掉上一条的弹幕，否则新视频会投放旧视频的内容。
 */
export function useShortsDanmaku(cid: number, visible: boolean) {
  const [entries, setEntries] = useState<readonly VideoDanmakuEntry[]>([]);
  const loadedRef = useRef(new Map<number, readonly VideoDanmakuEntry[]>());
  const inFlightRef = useRef(new Set<number>());
  const exhaustedFromRef = useRef<number | null>(null);
  // 开关只影响这个 ref 的读数，不进 `ensure` 的依赖：否则开关弹幕会改变
  // 回调身份，把依赖它的播放器 effect 一起重建、从 0 秒重播。
  const visibleRef = useRef(visible);
  useLayoutEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const [loadedCid, setLoadedCid] = useState(cid);
  if (loadedCid !== cid) {
    setLoadedCid(cid);
    setEntries([]);
  }
  useEffect(() => {
    loadedRef.current = new Map();
    inFlightRef.current = new Set();
    exhaustedFromRef.current = null;
  }, [cid]);

  const ensure = useCallback(
    (positionMs: number) => {
      if (!cid || !visibleRef.current) return;
      // 换片会把 map/set 换成新实例；在途请求带着旧引用回来时据此丢弃。
      const segments = loadedRef.current;
      const inFlight = inFlightRef.current;
      for (const segment of videoDanmakuSegmentsFor(positionMs)) {
        const exhaustedFrom = exhaustedFromRef.current;
        if (exhaustedFrom !== null && segment >= exhaustedFrom) continue;
        if (segments.has(segment) || inFlight.has(segment)) continue;
        inFlight.add(segment);
        void videoGetDanmaku(cid, segment)
          .then((result) => {
            if (loadedRef.current !== segments) return;
            segments.set(segment, videoDanmakuEntries(result.items, segment));
            if (!result.has_more) {
              exhaustedFromRef.current =
                exhaustedFromRef.current === null
                  ? segment + 1
                  : Math.min(exhaustedFromRef.current, segment + 1);
            }
            setEntries(mergeVideoDanmakuEntries([...segments.values()]));
          })
          .catch(() => {
            // 单段失败不影响其余段落；下次经过这个位置会再试一次。
          })
          .finally(() => {
            inFlight.delete(segment);
          });
      }
    },
    [cid],
  );

  // 换片与开启弹幕时先把 0 位置那一段拉起来。
  useEffect(() => {
    if (visible) ensure(0);
  }, [visible, ensure]);

  return { entries, ensure };
}
